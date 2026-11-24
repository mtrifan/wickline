// API integration tests: the real self-hosted server (and real upstream) on a random port, with a
// temporary data directory. No market data is fetched: unauthenticated requests stop before
// upstream, and authenticated ones only touch routes that answer locally.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSelfhost } from '../../server.mjs';
import { loadConfig } from '../../config.mjs';
import { silentLogger } from '../../log.mjs';
import { generateSecret, totp } from '../../auth/totp.mjs';

const PASSWORD = 'correct horse battery staple';
const dirs = [];
const apps = [];
after(async () => { for (const a of apps) await a.close().catch(() => {}); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function start(env = {}, dataDir) {
  const dir = dataDir || mkdtempSync(path.join(tmpdir(), 'wl-api-'));
  if (!dataDir) dirs.push(dir);
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, WICKLINE_PASSWORD: PASSWORD, ...env });
  const app = await startSelfhost(cfg, { log: silentLogger() });
  apps.push(app);
  const base = `http://127.0.0.1:${app.port}`;
  return { app, dir, base, cfg };
}

/** fetch without following redirects. */
const req = (url, opts = {}) => fetch(url, { redirect: 'manual', ...opts });
const form = (o) => new URLSearchParams(o).toString();
const FORM = 'application/x-www-form-urlencoded';

async function login(base, fields = {}, headers = {}) {
  const r = await req(`${base}/selfhost/login`, { method: 'POST', headers: { 'content-type': FORM, origin: base, ...headers }, body: form({ password: PASSWORD, next: '/', ...fields }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { r, cookie };
}

/** Every /api route upstream serves, read from its source so new routes are covered automatically. */
function upstreamApiRoutes() {
  const src = readFileSync(fileURLToPath(new URL('../../../server.mjs', import.meta.url)), 'utf8');
  const routes = new Set([...src.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/startsWith\('(\/api\/[^']+\/)'\)/g)) routes.add(`${m[1]}x`);
  if (/\^\\\/api\\\/universe\\\//.test(src)) routes.add('/api/universe/us-stocks');
  return [...routes];
}

test('readiness is open and minimal; /api/health needs a login', async () => {
  const { base } = await start();
  const r = await req(`${base}/api/health/ready`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal((await req(`${base}/api/health`)).status, 401);
});

test('every upstream API route is protected (401 JSON, never a redirect)', async () => {
  const { base } = await start();
  const routes = upstreamApiRoutes();
  assert.ok(routes.length >= 12, `found ${routes.length} upstream routes`);
  for (const route of [...routes, '/api/selfhost/session', '/api/does-not-exist']) {
    const r = await req(`${base}${route}`);
    assert.equal(r.status, 401, route);
    assert.match(r.headers.get('content-type'), /json/, route);
  }
});

test('pages redirect to the login page, keeping the path', async () => {
  const { base } = await start();
  for (const p of ['/', '/index.html', '/js/app.js', '/?s=AAPL']) {
    const r = await req(`${base}${p}`);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), `/selfhost/login?next=${encodeURIComponent(p)}`);
  }
  const page = await req(`${base}/selfhost/login`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/selfhost\/login"/);
});

test('login: wrong password is throttled; right password gives a hardened session cookie', async () => {
  const { base } = await start();
  const bad = await login(base, { password: 'wrong password!!' });
  assert.equal(bad.r.status, 401);
  assert.equal(bad.cookie, '');
  const throttled = await login(base);
  assert.equal(throttled.r.status, 429, 'even the right password waits out the delay');
  assert.ok(Number(throttled.r.headers.get('retry-after')) >= 1);
  await new Promise((r) => setTimeout(r, 1100));

  const { r, cookie } = await login(base, { next: '/?s=AAPL', hash: '#s=AAPL&tf=1D' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/?s=AAPL#s=AAPL&tf=1D', 'returns to the page and its chart');
  const set = r.headers.get('set-cookie');
  assert.match(set, /^wl_session=[\w-]{40,};/);
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(set.includes(attr), attr);
  assert.ok(!set.includes('Secure'), 'plain-HTTP LAN: no Secure flag (COOKIE_SECURE=auto)');

  const health = await req(`${base}/api/health`, { headers: { cookie } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).app, 'wickline');
  assert.equal(health.headers.get('access-control-allow-origin'), null, "upstream's CORS * is stripped");
  assert.equal(health.headers.get('x-frame-options'), 'DENY');

  const app = await req(`${base}/`, { headers: { cookie } });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /<title>Wickline<\/title>/);

  const session = await (await req(`${base}/api/selfhost/session`, { headers: { cookie } })).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.via, 'session');
});

test('open redirects and header injection through next/hash are refused', async () => {
  const { base } = await start();
  const { r } = await login(base, { next: '//evil.example/x', hash: '#a\r\nSet-Cookie: x=1' });
  assert.equal(r.headers.get('location'), '/');
});

test('state-changing requests need a same-origin Origin header', async () => {
  const { base } = await start();
  const { cookie } = await login(base);
  const noOrigin = await req(`${base}/selfhost/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(noOrigin.status, 403);
  const evil = await req(`${base}/selfhost/logout`, { method: 'POST', headers: { cookie, origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  const crossLogin = await req(`${base}/selfhost/login`, { method: 'POST', headers: { 'content-type': FORM, origin: 'http://evil.example' }, body: form({ password: PASSWORD }) });
  assert.equal(crossLogin.status, 403, 'no login CSRF');
  const ok = await req(`${base}/selfhost/logout`, { method: 'POST', headers: { cookie, origin: base } });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await req(`${base}/api/health`, { headers: { cookie } })).status, 401, 'logged out server-side');
});

test('sessions survive a restart (same data directory)', async () => {
  const first = await start();
  const { cookie } = await login(first.base);
  await first.app.close();
  const second = await start({}, first.dir);
  assert.equal((await req(`${second.base}/api/health`, { headers: { cookie } })).status, 200);
});

test('TOTP: required when configured, and a used code cannot be replayed', async () => {
  const secret = generateSecret();
  const { base } = await start({ WICKLINE_TOTP_SECRET: secret });
  assert.match(await (await req(`${base}/selfhost/login`)).text(), /autocomplete="one-time-code"/);
  const missing = await login(base);
  assert.equal(missing.r.status, 401);
  await new Promise((r) => setTimeout(r, 1100));
  const code = totp(secret);
  const ok = await login(base, { code });
  assert.equal(ok.r.status, 302);
  assert.ok(ok.cookie);
  const replay = await login(base, { code });
  assert.equal(replay.r.status, 401, 'same code twice');
});

test('public mode: HTTPS via the trusted proxy only, Secure cookie, HSTS', async () => {
  const hash = (await import('../../auth/password.mjs')).hashPassword(PASSWORD, { N: 1024 });
  const secret = generateSecret();
  const { base, app } = await start({ EXPOSURE: 'public', WICKLINE_PASSWORD: '', WICKLINE_PASSWORD_HASH: hash, WICKLINE_TOTP_SECRET: secret, TRUST_PROXY: '1' });
  const host = `127.0.0.1:${app.port}`;
  const plain = await req(`${base}/selfhost/login`);
  assert.equal(plain.status, 403, 'plain HTTP refused');
  assert.equal((await req(`${base}/api/health/ready`)).status, 200, 'readiness stays reachable for the container healthcheck');

  const viaProxy = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.7' };
  const page = await req(`${base}/selfhost/login`, { headers: viaProxy });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('strict-transport-security'), /max-age=/);
  const { r, cookie } = await login(base, { code: totp(secret) }, { ...viaProxy, origin: `https://${host}` });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('set-cookie'), /; Secure/);
  assert.equal((await req(`${base}/api/health`, { headers: { ...viaProxy, cookie } })).status, 200);
  const token = app.store.createToken('x').token;
  assert.equal((await req(`${base}/api/health`, { headers: { ...viaProxy, authorization: `Bearer ${token}` } })).status, 401, 'API tokens off in public mode by default');
});

test('API tokens work as bearer credentials in private mode', async () => {
  const { base, app } = await start();
  const { token } = app.store.createToken('script');
  assert.equal((await req(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await req(`${base}/api/health`, { headers: { authorization: 'Bearer wl_nope' } })).status, 401);
});

test('AUTH_MODE=none serves everything without a login', async () => {
  const { base } = await start({ AUTH_MODE: 'none', I_UNDERSTAND_NO_AUTH: 'true', WICKLINE_PASSWORD: '' });
  assert.equal((await req(`${base}/api/health`)).status, 200);
  assert.equal((await req(`${base}/`)).status, 200);
});

test('shutdown completes promptly with a long-lived stream open', async () => {
  const { base, app } = await start();
  const { cookie } = await login(base);
  // An empty-symbol Yahoo stream stays open (SSE) without contacting Yahoo.
  const opened = new Promise((resolve, reject) => {
    const r = http.get(`${base}/api/yahoo/stream?symbols=`, { headers: { cookie } }, (res) => { res.once('data', () => resolve(res)); });
    r.on('error', reject);
  });
  const stream = await opened;
  assert.equal(stream.statusCode, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  const t0 = Date.now();
  await app.close();
  assert.ok(Date.now() - t0 < 5000, `closed in ${Date.now() - t0} ms`);
  assert.equal((await fetch(`${base}/api/health/ready`).catch(() => null)), null, 'port closed');
});
