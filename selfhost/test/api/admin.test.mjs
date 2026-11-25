// Backup download, portable export/import, and backup -> restore round-trips against the real server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startSelfhost } from '../../server.mjs';
import { loadConfig } from '../../config.mjs';
import { silentLogger } from '../../log.mjs';
import { restoreDatabase, RestoreError } from '../../storage/backup.mjs';

const PASSWORD = 'correct horse battery staple';
const dirs = [];
const apps = [];
after(async () => { for (const a of apps) await a.close().catch(() => {}); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'wl-admin-')); dirs.push(d); return d; };

async function start(env = {}, dataDir = tmp()) {
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, WICKLINE_PASSWORD: PASSWORD, ...env });
  const app = await startSelfhost(cfg, { log: silentLogger() });
  apps.push(app);
  const base = `http://127.0.0.1:${app.port}`;
  const r = await fetch(`${base}/selfhost/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }).toString() });
  return { app, base, dir: dataDir, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const writeHeaders = (ctx) => ({ origin: ctx.base, cookie: ctx.cookie, 'x-wickline-selfhost': '1', 'content-type': 'application/json' });
const snapshot = async (ctx) => (await fetch(`${ctx.base}/api/selfhost/state`, { headers: { cookie: ctx.cookie } })).json();
async function put(ctx, key, value) {
  const s = await snapshot(ctx);
  const r = await fetch(`${ctx.base}/api/selfhost/state/${encodeURIComponent(key)}`, { method: 'PUT', headers: writeHeaders(ctx), body: JSON.stringify({ value, baseVersion: s.keys[key]?.ver ?? 0, epoch: s.epoch }) });
  assert.equal(r.status, 200);
}
const importJson = (ctx, body, headers = writeHeaders(ctx)) => fetch(`${ctx.base}/api/selfhost/import`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const values = (snap) => Object.fromEntries(Object.entries(snap.keys).filter(([, k]) => !k.deleted).map(([n, k]) => [n, k.v]));

test('export -> import into a fresh server reproduces all synced state', async () => {
  const a = await start();
  await put(a, 'watchlist', '["AAPL","MSFT"]');
  await put(a, 'drawings.EUR/USD', '[{"type":"hline"}]');
  await put(a, 'scripts', '[{"id":"s1","name":"x","code":"plot(close)","updated":1}]');
  await put(a, 'theme', '"light"');
  await put(a, 'theme', '"dark"');
  const res = await fetch(`${a.base}/api/selfhost/export`, { headers: { cookie: a.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="wickline-export-\d{8}-\d{6}\.json"$/);
  const exported = await res.json();
  assert.equal(exported.app, 'wickline-selfhost');
  assert.equal(exported.format, 1);

  const b = await start();
  const before = await snapshot(b);
  const r = await importJson(b, exported);
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.keys, 4);
  const after = await snapshot(b);
  assert.notEqual(after.epoch, before.epoch, 'a new epoch');
  assert.deepEqual(values(after), values(await snapshot(a)));
});

test('import replaces everything, resets open streams, and validates its input', async () => {
  const ctx = await start();
  await put(ctx, 'watchlist', '["OLD"]');
  await put(ctx, 'news', '{"x":1}');
  const { epoch } = await snapshot(ctx);
  const ended = new Promise((resolve) => {
    http.get(`${ctx.base}/api/selfhost/events?epoch=${epoch}&since=0`, { headers: { cookie: ctx.cookie } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve(buf));
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  const r = await importJson(ctx, { app: 'wickline-selfhost', format: 1, keys: { watchlist: '["NEW"]' } });
  assert.equal(r.status, 200);
  assert.match(await ended, /event: reset/);
  assert.deepEqual(values(await snapshot(ctx)), { watchlist: '["NEW"]' });

  assert.equal((await importJson(ctx, { app: 'other', format: 1, keys: {} })).status, 422);
  assert.equal((await importJson(ctx, { app: 'wickline-selfhost', format: 2, keys: {} })).status, 422);
  assert.equal((await importJson(ctx, { app: 'wickline-selfhost', format: 1, keys: { notAKey: '"x"' } })).status, 422);
  assert.equal((await importJson(ctx, { app: 'wickline-selfhost', format: 1, keys: { theme: 1 } })).status, 422);
  assert.equal((await importJson(ctx, { app: 'wickline-selfhost', format: 1, keys: [] })).status, 422);
  assert.equal((await importJson(ctx, '{nope')).status, 400);
  const { 'x-wickline-selfhost': _, ...noHeader } = writeHeaders(ctx);
  assert.equal((await importJson(ctx, { app: 'wickline-selfhost', format: 1, keys: {} }, noHeader)).status, 403);
  assert.deepEqual(values(await snapshot(ctx)), { watchlist: '["NEW"]' }, 'refused imports change nothing');
  assert.equal((await fetch(`${ctx.base}/api/selfhost/import`, { headers: { cookie: ctx.cookie } })).status, 405);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/export`)).status, 401);
});

test('scripts can import with an API token and no Origin header; a bad token is refused', async () => {
  const ctx = await start();
  const { token } = ctx.app.store.createToken('script');
  const body = JSON.stringify({ app: 'wickline-selfhost', format: 1, keys: { theme: '"dark"' } });
  const ok = await fetch(`${ctx.base}/api/selfhost/import`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-wickline-selfhost': '1', 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${ctx.base}/api/selfhost/import`, { method: 'POST', headers: { authorization: 'Bearer wl_nope', cookie: ctx.cookie, 'x-wickline-selfhost': '1', 'content-type': 'application/json' }, body });
  assert.equal(bad.status, 401, 'a bad token never falls back to the cookie');
  const cross = await fetch(`${ctx.base}/api/selfhost/import`, { method: 'POST', headers: { ...writeHeaders(ctx), origin: 'https://evil.example' }, body });
  assert.equal(cross.status, 403, 'cookie requests still need the same origin');
});

test('the backup download is a consistent database file and leaves no temporary file behind', async () => {
  const ctx = await start();
  await put(ctx, 'watchlist', '["BACKUP"]');
  const res = await fetch(`${ctx.base}/api/selfhost/backup`, { headers: { cookie: ctx.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="wickline-\d{8}-\d{6}\.db"$/);
  const file = path.join(tmp(), 'download.db');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM kv_state WHERE key = 'watchlist'").get().value, '["BACKUP"]');
  db.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(readdirSync(path.join(ctx.dir, 'backups')).filter((n) => n.startsWith('.download-')), []);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/backup`)).status, 401);
});

test('backup -> restore round-trip: equal state, a new epoch, refused while running', async () => {
  const dir = tmp();
  const first = await start({}, dir);
  await put(first, 'watchlist', '["KEEP"]');
  await put(first, 'drawings.AAPL', '[1]');
  const kept = values(await snapshot(first));
  const res = await fetch(`${first.base}/api/selfhost/backup`, { headers: { cookie: first.cookie } });
  const file = path.join(tmp(), 'b.db');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  await put(first, 'watchlist', '["LATER"]');
  const epochBefore = (await snapshot(first)).epoch;
  assert.throws(() => restoreDatabase(dir, file), (e) => e instanceof RestoreError && /is running/.test(e.message));
  await first.app.close();

  restoreDatabase(dir, file);
  const second = await start({}, dir);
  const snap = await snapshot(second);
  assert.deepEqual(values(snap), kept);
  assert.notEqual(snap.epoch, epochBefore);
});

test('BACKUP_INTERVAL_HOURS and BACKUP_KEEP are validated', () => {
  assert.throws(() => loadConfig({ WICKLINE_PASSWORD: PASSWORD, BACKUP_INTERVAL_HOURS: '-1' }), /BACKUP_INTERVAL_HOURS/);
  assert.throws(() => loadConfig({ WICKLINE_PASSWORD: PASSWORD, BACKUP_KEEP: '0' }), /BACKUP_KEEP/);
  const cfg = loadConfig({ WICKLINE_PASSWORD: PASSWORD, BACKUP_INTERVAL_HOURS: '0' });
  assert.deepEqual([cfg.backupIntervalHours, cfg.backupKeep], [0, 14]);
});

test('only one backup download runs at a time', async () => {
  const ctx = await start();
  await put(ctx, 'drawings.BIG', 'x'.repeat(4_000_000)); // large enough not to fit in socket buffers
  // a slow client: reads the headers, then nothing
  const slow = await new Promise((resolve) => {
    const req = http.get(`${ctx.base}/api/selfhost/backup`, { headers: { cookie: ctx.cookie } }, (res) => { res.pause(); resolve({ req, res }); });
  });
  assert.equal(slow.res.statusCode, 200);
  const second = await fetch(`${ctx.base}/api/selfhost/backup`, { headers: { cookie: ctx.cookie } });
  assert.equal(second.status, 429);
  slow.req.destroy();
  let third;
  for (let i = 0; i < 50; i++) { // the server notices the closed socket shortly
    third = await fetch(`${ctx.base}/api/selfhost/backup`, { headers: { cookie: ctx.cookie } });
    if (third.status !== 429) break;
    await third.arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(third.status, 200);
  await third.arrayBuffer();
});

test('a stalled backup download is cut off, so later downloads work', async () => {
  const { createAdminRoutes } = await import('../../http/admin.mjs');
  const ctx = await start();
  await put(ctx, 'drawings.BIG', 'x'.repeat(4_000_000));
  const handle = createAdminRoutes({ state: ctx.app.sync, db: ctx.app.db, dataDir: ctx.dir, version: {}, downloadTimeoutMs: 200 });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/selfhost/backup`;
  const stalled = await new Promise((resolve) => http.get(url, (res) => { res.pause(); resolve(res); }));
  assert.equal(stalled.statusCode, 200);
  assert.equal((await fetch(url)).status, 429);
  await new Promise((r) => setTimeout(r, 400)); // past the timeout
  const next = await fetch(url);
  assert.equal(next.status, 200);
  await next.arrayBuffer();
  stalled.destroy();
  await new Promise((r) => server.close(r));
});
