// Sync API against the real server: snapshot, policy-checked writes under concurrency, and the
// event stream (fan-out, Last-Event-ID resume with tombstones, resets, logout).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { startSelfhost } from '../../server.mjs';
import { loadConfig } from '../../config.mjs';
import { silentLogger } from '../../log.mjs';
import { openDatabase, loadMigrations } from '../../storage/db.mjs';

const PASSWORD = 'correct horse battery staple';
const dirs = [];
const apps = [];
after(async () => { for (const a of apps) await a.close().catch(() => {}); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function start(env = {}, dataDir) {
  const dir = dataDir || mkdtempSync(path.join(tmpdir(), 'wl-sync-api-'));
  if (!dataDir) dirs.push(dir);
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, WICKLINE_PASSWORD: PASSWORD, ...env });
  const app = await startSelfhost(cfg, { log: silentLogger() });
  apps.push(app);
  const base = `http://127.0.0.1:${app.port}`;
  const r = await fetch(`${base}/selfhost/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ password: PASSWORD, next: '/' }).toString(),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('wl_session='));
  return { app, dir, base, cookie };
}

const mutating = (base, cookie) => ({ origin: base, cookie, 'x-wickline-selfhost': '1', 'content-type': 'application/json' });

async function snapshot({ base, cookie }) {
  const r = await fetch(`${base}/api/selfhost/state`, { headers: { cookie } });
  assert.equal(r.status, 200);
  return r.json();
}

async function put(ctx, key, body, method = 'PUT') {
  const r = await fetch(`${ctx.base}/api/selfhost/state/${encodeURIComponent(key)}`, { method, headers: mutating(ctx.base, ctx.cookie), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** Opens an event stream; `events` fills as frames arrive. */
function stream(ctx, query, headers = {}) {
  const events = [];
  let ended = false;
  const waiters = [];
  const poke = () => { for (const w of waiters.splice(0)) w(); };
  const req = http.get(`${ctx.base}/api/selfhost/events?${new URLSearchParams(query)}`, { headers: { cookie: ctx.cookie, ...headers } });
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      resolve(res);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const f = {};
          for (const line of block.split('\n')) {
            const m = /^(id|event|data): (.*)$/.exec(line);
            if (m) f[m[1]] = m[1] === 'data' ? JSON.parse(m[2]) : m[2];
          }
          if (f.event) { events.push(f); poke(); }
        }
      });
      res.on('end', () => { ended = true; poke(); });
    });
    req.on('error', reject);
  });
  const until = async (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { events, ready, until, get ended() { return ended; }, close: () => req.destroy() };
}

test('sync routes need a login, the header on writes, JSON bodies and synced keys', async () => {
  const ctx = await start();
  assert.equal((await fetch(`${ctx.base}/api/selfhost/state`)).status, 401);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/events`)).status, 401);
  const { epoch } = await snapshot(ctx);

  const noHeader = await fetch(`${ctx.base}/api/selfhost/state/theme`, { method: 'PUT', headers: { origin: ctx.base, cookie: ctx.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const form = await fetch(`${ctx.base}/api/selfhost/state/theme`, { method: 'PUT', headers: { ...mutating(ctx.base, ctx.cookie), 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=x' });
  assert.equal(form.status, 415);

  assert.equal((await put(ctx, 'tdKey', { value: 'k', baseVersion: 0, epoch })).status, 422);
  assert.equal((await put(ctx, 'nope', { value: 'k', baseVersion: 0, epoch })).status, 422);
  assert.equal((await put(ctx, 'theme', { value: 1, baseVersion: 0, epoch })).status, 400);
  assert.equal((await put(ctx, 'theme', { value: 'x', baseVersion: -1, epoch })).status, 400);
  assert.equal((await put(ctx, 'theme', { value: 'x', baseVersion: 0 })).status, 400);
  assert.equal((await put(ctx, 'theme', { value: 'x', baseVersion: 0, epoch, clientId: 'bad id!' })).status, 400);
  assert.equal((await put(ctx, 'theme', { value: 'x', baseVersion: 0, epoch: 'deadbeefdeadbeef' })).body.error, 'epoch');
  assert.equal((await put(ctx, 'theme', { value: 'x', baseVersion: 0, epoch: 'e'.repeat(65) })).status, 400);
  assert.equal((await put(ctx, 'theme', { value: 'x'.repeat(5_000_001), baseVersion: 0, epoch })).status, 413);
  const delNoHeader = await fetch(`${ctx.base}/api/selfhost/state/theme`, { method: 'DELETE', headers: { origin: ctx.base, cookie: ctx.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(delNoHeader.status, 403);
  const crossSite = await fetch(`${ctx.base}/api/selfhost/state/theme`, { method: 'PUT', headers: { ...mutating(ctx.base, ctx.cookie), origin: 'https://evil.example' }, body: JSON.stringify({ value: 'x', baseVersion: 0, epoch }) });
  assert.equal(crossSite.status, 403);
  const bad = await fetch(`${ctx.base}/api/selfhost/state/theme`, { method: 'POST', headers: mutating(ctx.base, ctx.cookie), body: '{}' });
  assert.equal(bad.status, 405);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/state/%E0%A4%A`, { method: 'PUT', headers: mutating(ctx.base, ctx.cookie), body: '{}' })).status, 400);
  assert.equal((await snapshot(ctx)).rev, 0, 'nothing was written');
});

test('write, delete and snapshot a key; drawings keys with special characters round-trip', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  assert.deepEqual((await put(ctx, 'watchlist', { value: '["AAPL"]', baseVersion: 0, epoch, clientId: 'A' })).body, { version: 1, rev: 1, deleted: false });
  assert.equal((await put(ctx, 'drawings.EUR/USD', { value: '[]', baseVersion: 0, epoch })).status, 200);
  assert.deepEqual((await put(ctx, 'watchlist', { baseVersion: 1, epoch }, 'DELETE')).body, { version: 2, rev: 3, deleted: true });
  const snap = await snapshot(ctx);
  assert.deepEqual(snap.keys, {
    watchlist: { v: null, ver: 2, deleted: true },
    'drawings.EUR/USD': { v: '[]', ver: 1, deleted: false },
  });
});

test('concurrent writes: CAS admits exactly one; LWW versions strictly increase and the highest wins', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const N = 20;
  const cas = await Promise.all(Array.from({ length: N }, (_, i) => put(ctx, 'paper', { value: `{"n":${i}}`, baseVersion: 0, epoch, clientId: `c${i}` })));
  assert.equal(cas.filter((r) => r.status === 200).length, 1);
  assert.equal(cas.filter((r) => r.status === 409 && r.body.error === 'conflict' && r.body.version === 1).length, N - 1);

  const lww = await Promise.all(Array.from({ length: N }, (_, i) => put(ctx, 'screener', { value: `v${i}`, baseVersion: 0, epoch })));
  const versions = lww.map((r) => r.body.version).sort((a, b) => a - b);
  assert.deepEqual(versions, Array.from({ length: N }, (_, i) => i + 1));
  const winner = lww.find((r) => r.body.version === N);
  const sent = `v${lww.indexOf(winner)}`;
  assert.equal((await snapshot(ctx)).keys.screener.v, sent);
});

test('a stale beforeunload paper write is rejected with the current value', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'paper', { value: '{"cash":100}', baseVersion: 0, epoch });
  await put(ctx, 'paper', { value: '{"cash":50}', baseVersion: 1, epoch });
  const stale = await put(ctx, 'paper', { value: '{"cash":100,"old":true}', baseVersion: 1, epoch });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'conflict', version: 2, value: '{"cash":50}', deleted: false });
});

test('every connected stream receives each change, tagged with the writer', async () => {
  const ctx = await start();
  const { epoch, rev } = await snapshot(ctx);
  const a = stream(ctx, { epoch, since: rev });
  const b = stream(ctx, { epoch, since: rev });
  assert.equal((await a.ready).headers['content-type'], 'text/event-stream; charset=utf-8');
  await b.ready;
  await new Promise((r) => setTimeout(r, 50));
  const r = await put(ctx, 'theme', { value: 'dark', baseVersion: 0, epoch, clientId: 'tabA' });
  for (const s of [a, b]) {
    await s.until(() => s.events.length === 1);
    assert.deepEqual(s.events[0], { id: String(r.body.rev), event: 'change', data: { key: 'theme', v: 'dark', ver: 1, deleted: false, rev: 1, by: 'tabA' } });
  }
  await put(ctx, 'theme', { value: 'dark', baseVersion: 1, epoch });
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(a.events.length, 1, 'no-op writes are not broadcast (no ping-pong)');
  a.close(); b.close();
});

test('Last-Event-ID resumes from the missed changes, deletions included', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'theme', { value: 'a', baseVersion: 0, epoch });
  await put(ctx, 'lang', { value: 'en', baseVersion: 0, epoch });
  await put(ctx, 'lang', { baseVersion: 1, epoch }, 'DELETE');
  const s = stream(ctx, { epoch, since: 0 }, { 'last-event-id': '1' }); // header beats ?since
  await s.until(() => s.events.length === 1);
  assert.deepEqual(s.events.map((e) => [e.id, e.data.key, e.data.deleted]), [['3', 'lang', true]]);
  s.close();
});

test('a stream from another epoch, or ahead of the server, is reset and closed', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const wrongEpoch = stream(ctx, { epoch: 'feedfacefeedface', since: 0 });
  await wrongEpoch.until(() => wrongEpoch.ended);
  assert.deepEqual(wrongEpoch.events, [{ event: 'reset', data: { epoch, rev: 0 } }]);
  const ahead = stream(ctx, { epoch, since: 99 });
  await ahead.until(() => ahead.ended);
  assert.equal(ahead.events[0].event, 'reset');
  const garbage = stream(ctx, { epoch, since: 'x' });
  await garbage.until(() => garbage.ended);
  assert.equal(garbage.events[0].event, 'reset');
});

test('resetAll tells open streams to re-hydrate in the new epoch', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const s = stream(ctx, { epoch, since: 0 });
  await s.ready;
  await new Promise((r) => setTimeout(r, 50));
  const next = ctx.app.sync.resetEpoch();
  ctx.app.hub.resetAll();
  await s.until(() => s.ended);
  assert.deepEqual(s.events, [{ event: 'reset', data: { epoch: next, rev: 0 } }]);
});

test('logging out closes that session\'s streams', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const s = stream(ctx, { epoch, since: 0 });
  await s.ready;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.app.hub.size, 1);
  await fetch(`${ctx.base}/selfhost/logout`, { method: 'POST', redirect: 'manual', headers: { origin: ctx.base, cookie: ctx.cookie } });
  await s.until(() => s.ended);
  assert.equal(ctx.app.hub.size, 0);
});

test('state survives a restart with the same data directory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-sync-api-'));
  dirs.push(dir);
  const first = await start({}, dir);
  const { epoch } = await snapshot(first);
  await put(first, 'watchlist', { value: '["MSFT"]', baseVersion: 0, epoch });
  await first.app.close();
  const second = await start({}, dir);
  const snap = await snapshot(second);
  assert.equal(snap.epoch, epoch);
  assert.deepEqual(snap.keys.watchlist, { v: '["MSFT"]', ver: 1, deleted: false });
});

test('a Phase 1 database upgrades to the sync schema after a backup', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-sync-api-'));
  dirs.push(dir);
  const phase1 = mkdtempSync(path.join(tmpdir(), 'wl-mig-'));
  dirs.push(phase1);
  const { writeFileSync, readFileSync } = await import('node:fs');
  const real = new URL('../../storage/migrations/', import.meta.url);
  writeFileSync(path.join(phase1, '001_auth.sql'), readFileSync(new URL('001_auth.sql', real)));
  openDatabase(dir, { migrationsDir: phase1 }).db.close();
  const { db, migrated, backup } = openDatabase(dir);
  assert.deepEqual(migrated, loadMigrations().slice(1).map((m) => m.name));
  assert.ok(backup && readdirSync(path.join(dir, 'backups')).length === 1);
  assert.match(db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get().value, /^[0-9a-f]{16}$/);
  db.close();
});

test('SYNC_WORKSPACE=false refuses workspace writes', async () => {
  const ctx = await start({ SYNC_WORKSPACE: 'false' });
  const { epoch } = await snapshot(ctx);
  assert.equal((await put(ctx, 'workspace', { value: '{}', baseVersion: 0, epoch })).status, 422);
});

test('streams are re-checked: an expired session or a revoked token loses its stream', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const viaSession = stream(ctx, { epoch, since: 0 });
  const { id, token } = ctx.app.store.createToken('test');
  const viaToken = stream({ ...ctx, cookie: '' }, { epoch, since: 0 }, { authorization: `Bearer ${token}` });
  await viaSession.ready; await viaToken.ready;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.app.hub.size, 2);
  ctx.app.hub.revalidate();
  assert.equal(ctx.app.hub.size, 2, 'valid credentials keep their streams');
  ctx.app.store.deleteSession(ctx.cookie.slice('wl_session='.length)); // expiry or `cli.mjs` revocation, not a logout
  ctx.app.store.deleteToken(id);
  ctx.app.hub.revalidate();
  await viaSession.until(() => viaSession.ended);
  await viaToken.until(() => viaToken.ended);
  assert.equal(ctx.app.hub.size, 0);
});

test('a backlog larger than the buffer cap is answered with reset, not replayed', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const big = 'x'.repeat(4_500_000);
  assert.equal((await put(ctx, 'drawings.A', { value: big, baseVersion: 0, epoch })).status, 200);
  assert.equal((await put(ctx, 'drawings.B', { value: big, baseVersion: 0, epoch })).status, 200);
  const s = stream(ctx, { epoch, since: 0 });
  await s.until(() => s.ended);
  assert.deepEqual(s.events.map((e) => e.event), ['reset']);
  const recent = stream(ctx, { epoch, since: 1 });
  await recent.until(() => recent.events.length === 1);
  assert.equal(recent.events[0].data.key, 'drawings.B', 'a small backlog still replays');
  recent.close();
});

test('a stream without since or Last-Event-ID replays all current state', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'theme', { value: 'a', baseVersion: 0, epoch });
  const s = stream(ctx, { epoch });
  await s.until(() => s.events.length === 1);
  assert.equal(s.ended, false);
  assert.equal(s.events[0].data.key, 'theme');
  s.close();
});

test('resetEpoch alone resets the open streams', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  const s = stream(ctx, { epoch, since: 0 });
  await s.ready;
  await new Promise((r) => setTimeout(r, 50));
  const next = ctx.app.sync.resetEpoch();
  await s.until(() => s.ended);
  assert.deepEqual(s.events, [{ event: 'reset', data: { epoch: next, rev: 0 } }]);
});

test('concurrent merges keep every added entry and converge on every stream', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'scripts', { value: '[]', baseVersion: 0, epoch });
  const s = stream(ctx, { epoch, since: 1 });
  await s.ready;
  await new Promise((r) => setTimeout(r, 50));
  const N = 10;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => put(ctx, 'scripts', { value: JSON.stringify([{ id: `s${i}`, updated: i }]), baseVersion: 1, epoch })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.deepEqual(rs.map((r) => r.body.version).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 2));
  const final = JSON.parse((await snapshot(ctx)).keys.scripts.v).map((e) => e.id).sort();
  assert.deepEqual(final, Array.from({ length: N }, (_, i) => `s${i}`).sort());
  await s.until(() => s.events.length === N);
  assert.equal(s.events.at(-1).data.v, (await snapshot(ctx)).keys.scripts.v);
  s.close();
});

test('with SYNC_WORKSPACE=false a stored workspace never reaches the stream', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-sync-api-'));
  dirs.push(dir);
  const on = await start({}, dir);
  await put(on, 'workspace', { value: '{"w":1}', baseVersion: 0, epoch: (await snapshot(on)).epoch });
  await on.app.close();
  const off = await start({ SYNC_WORKSPACE: 'false' }, dir);
  const { epoch } = await snapshot(off);
  await put(off, 'theme', { value: 'a', baseVersion: 0, epoch });
  const s = stream(off, { epoch, since: 0 });
  await s.until(() => s.events.length === 1);
  assert.deepEqual(s.events.map((e) => e.data.key), ['theme']);
  s.close();
});

test('the event hub refuses streams beyond its limit', async () => {
  const { createEventHub } = await import('../../sync/events.mjs');
  const fakeState = { onChange: () => () => {}, onEpoch: () => () => {}, epoch: () => 'e', rev: () => 0, changesSince: () => [] };
  const hub = createEventHub(fakeState, { maxClients: 1 });
  const mkRes = () => { const r = { status: 0, writeHead(s) { r.status = s; }, write() {}, end() {}, on() {}, writableLength: 0 }; return r; };
  const req = { headers: {}, on() {} };
  const url = new URL('http://x/api/selfhost/events?epoch=e');
  const a = mkRes(); hub.handle(req, a, url);
  const b = mkRes(); hub.handle(req, b, url);
  assert.deepEqual([a.status, b.status, hub.size], [200, 503, 1]);
  hub.close();
});

test('an empty since or Last-Event-ID counts as absent', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'theme', { value: 'a', baseVersion: 0, epoch });
  for (const [query, headers] of [[{ epoch, since: '' }, {}], [{ epoch }, { 'last-event-id': '' }]]) {
    const s = stream(ctx, query, headers);
    await s.until(() => s.events.length === 1);
    assert.equal(s.events[0].event, 'change');
    assert.equal(s.ended, false);
    s.close();
  }
});

test('a resume from before a pruned tombstone is reset; a full replay is not', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'theme', { value: 'a', baseVersion: 0, epoch });
  ctx.app.db.prepare("UPDATE meta SET value = '1' WHERE key = 'pruned_rev'").run();
  await put(ctx, 'lang', { value: 'en', baseVersion: 0, epoch });
  const fromZero = stream(ctx, { epoch, since: 0 });
  await fromZero.until(() => fromZero.events.length === 2);
  fromZero.close();
  const fromOne = stream(ctx, { epoch, since: 1 });
  await fromOne.until(() => fromOne.events.length === 1);
  assert.equal(fromOne.events[0].event, 'change', 'since == pruned_rev missed nothing');
  fromOne.close();
  ctx.app.db.prepare("UPDATE meta SET value = '2' WHERE key = 'pruned_rev'").run();
  const stale = stream(ctx, { epoch, since: 1 });
  await stale.until(() => stale.ended);
  assert.equal(stale.events[0].event, 'reset');
});

test('index.html carries the escaped snapshot and loads boot.js first; boot.js is served', async () => {
  const ctx = await start();
  const { epoch } = await snapshot(ctx);
  await put(ctx, 'watchlist', { value: '["</script><script>x</script>"]', baseVersion: 0, epoch });
  for (const p of ['/', '/index.html', '/%69ndex.html', '/?popout=1']) {
    const r = await fetch(`${ctx.base}${p}`, { headers: { cookie: ctx.cookie } });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    const at = html.indexOf('<head>') + '<head>'.length;
    assert.ok(html.slice(at).startsWith('\n<script type="application/json" id="wl-snapshot">'), p);
    const json = JSON.parse(/id="wl-snapshot">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(json.keys.watchlist.v, '["</script><script>x</script>"]');
    assert.ok(json.sync.exact.includes('watchlist'));
    assert.ok(html.indexOf('/selfhost/boot.js') < html.indexOf("localStorage.getItem('wickline.theme')"), 'before the inline theme script');
  }
  const head = await fetch(`${ctx.base}/`, { method: 'HEAD', headers: { cookie: ctx.cookie } });
  assert.equal(head.status, 200);
  const js = await fetch(`${ctx.base}/selfhost/boot.js`, { headers: { cookie: ctx.cookie } });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.match(await js.text(), /wickline-selfhost\./);
  assert.equal((await fetch(`${ctx.base}/selfhost/boot.js`, { redirect: 'manual' })).status, 302, 'boot.js needs a login too');
});
