// Notification routes against the real server and a fake Gotify; configuration validation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSelfhost } from '../../server.mjs';
import { loadConfig, redacted } from '../../config.mjs';
import { silentLogger } from '../../log.mjs';

const PASSWORD = 'correct horse battery staple';
const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });

async function fakeGotify(status = 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ key: req.headers['x-gotify-key'], body: JSON.parse(raw || '{}') });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status < 300 ? '{"id":1}' : '{"error":"Unauthorized","errorDescription":"invalid token"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function start(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-notify-api-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startSelfhost(loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, WICKLINE_PASSWORD: PASSWORD, ...env }), { log: silentLogger() });
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const r = await fetch(`${base}/selfhost/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }).toString() });
  return { app, base, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const testNotify = (ctx, headers = {}) => fetch(`${ctx.base}/api/selfhost/notify/test`, { method: 'POST', headers: { origin: ctx.base, cookie: ctx.cookie, 'x-wickline-selfhost': '1', ...headers } });
const status = async (ctx) => (await fetch(`${ctx.base}/api/selfhost/notify/status`, { headers: { cookie: ctx.cookie } })).json();

test('the test notification reports success, and status shows the provider without its token', async () => {
  const g = await fakeGotify(200);
  const ctx = await start({ GOTIFY_URL: g.url, GOTIFY_TOKEN: 'app-token-123', PUBLIC_URL: 'https://wl.example' });
  const r = await testNotify(ctx);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, results: [{ provider: 'gotify', ok: true, status: 200, error: null }] });
  assert.equal(g.requests[0].key, 'app-token-123');
  assert.equal(g.requests[0].body.title, 'Wickline test notification');
  assert.equal(g.requests[0].body.extras['client::notification'].click.url, 'https://wl.example/');
  const s = await status(ctx);
  assert.deepEqual(s.providers, [{ id: 'gotify', configured: true, target: new URL(g.url).host }]);
  assert.doesNotMatch(JSON.stringify(s), /app-token-123/);
  assert.equal((await testNotify(ctx)).status, 429, 'tests are spaced');
});

test('the test notification reports the precise error', async () => {
  const g = await fakeGotify(401);
  const ctx = await start({ GOTIFY_URL: g.url, GOTIFY_TOKEN: 'wrong' });
  const body = await (await testNotify(ctx)).json();
  assert.deepEqual(body, { ok: false, results: [{ provider: 'gotify', ok: false, status: 401, error: 'Gotify answered 401 (Unauthorized: invalid token)' }] });
});

test('without a provider the test is refused; the routes need a login and the header', async () => {
  const ctx = await start();
  const r = await testNotify(ctx);
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /GOTIFY_URL and GOTIFY_TOKEN/);
  assert.deepEqual((await status(ctx)).providers, [{ id: 'gotify', configured: false, target: null }]);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/notify/status`)).status, 401);
  assert.equal((await testNotify(ctx, { 'x-wickline-selfhost': '' })).status, 403);
  assert.equal((await fetch(`${ctx.base}/api/selfhost/notify/test`, { headers: { cookie: ctx.cookie } })).status, 405);
});

test('notification settings are validated, the token can come from a file, and it is redacted', () => {
  const base = { WICKLINE_PASSWORD: PASSWORD };
  assert.throws(() => loadConfig({ ...base, GOTIFY_URL: 'https://gotify.lan' }), /GOTIFY_TOKEN/);
  assert.throws(() => loadConfig({ ...base, GOTIFY_TOKEN: 'x' }), /GOTIFY_URL is not/);
  assert.throws(() => loadConfig({ ...base, GOTIFY_URL: 'gotify.lan', GOTIFY_TOKEN: 'x' }), /GOTIFY_URL must be an absolute URL/);
  assert.throws(() => loadConfig({ ...base, GOTIFY_URL: 'ftp://gotify.lan', GOTIFY_TOKEN: 'x' }), /http:\/\/ or https:\/\//);
  assert.throws(() => loadConfig({ ...base, PUBLIC_URL: 'https://wl.example/?x=1' }), /PUBLIC_URL must not have a query/);
  assert.throws(() => loadConfig({ ...base, GOTIFY_URL: 'https://admin:hunter2@gotify.lan', GOTIFY_TOKEN: 'x' }), (e) => /user name or password/.test(e.message) && !/hunter2/.test(e.message));
  assert.throws(() => loadConfig({ ...base, GOTIFY_URL: 'not a url hunter2', GOTIFY_TOKEN: 'x' }), (e) => !/hunter2/.test(e.message), 'invalid values are not echoed');
  assert.throws(() => loadConfig({ ...base, GOTIFY_PRIORITY: '11' }), /GOTIFY_PRIORITY/);
  assert.throws(() => loadConfig({ ...base, NOTIFY_MAX_ATTEMPTS: '0' }), /NOTIFY_MAX_ATTEMPTS/);
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-cfg-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'token'), 'from-file\n');
  const cfg = loadConfig({ ...base, GOTIFY_URL: 'https://gotify.lan/sub/', GOTIFY_TOKEN_FILE: path.join(dir, 'token'), PUBLIC_URL: 'https://wl.example/' });
  assert.deepEqual([cfg.gotifyUrl, cfg.gotifyToken, cfg.publicUrl, cfg.gotifyPriority, cfg.notifyMaxAttempts], ['https://gotify.lan/sub', 'from-file', 'https://wl.example', 8, 8]);
  assert.equal(redacted(cfg).gotifyToken, '[set]');
});
