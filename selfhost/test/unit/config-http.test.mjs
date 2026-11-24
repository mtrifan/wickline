import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redacted, ConfigError } from '../../config.mjs';
import { clientInfo, parseCookies, serializeCookie, sameOrigin, safeNext } from '../../http/request.mjs';
import { stripCors } from '../../http/headers.mjs';

const HASH = 'scrypt$1024$8$1$c2FsdA==$aGFzaA==';
const problems = (env, opts) => { try { loadConfig(env, opts); return []; } catch (e) { assert.ok(e instanceof ConfigError, e.message); return e.problems; } };

test('private defaults need only a password', () => {
  const c = loadConfig({ WICKLINE_PASSWORD: 'correct horse battery', DATA_DIR: '/tmp/x' });
  assert.equal(c.exposure, 'private');
  assert.equal(c.port, 5173);
  assert.equal(c.trustProxy, 0);
  assert.deepEqual(problems({}).length, 1);
  assert.ok(problems({ WICKLINE_PASSWORD: 'short' }).some((p) => /12 characters/.test(p)));
});

test('secrets can come from *_FILE', () => {
  const c = loadConfig({ WICKLINE_PASSWORD_HASH_FILE: '/run/secrets/h' }, { readFile: () => `${HASH}\n` });
  assert.equal(c.passwordHash, HASH);
  assert.ok(problems({ WICKLINE_PASSWORD_HASH_FILE: '/nope' }, { readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }).some((p) => /cannot read/.test(p)));
});

test('public mode demands a hash, TOTP, a trusted proxy and secure cookies', () => {
  const p = problems({ EXPOSURE: 'public', WICKLINE_PASSWORD: 'correct horse battery', COOKIE_SECURE: 'false' });
  for (const re of [/requires WICKLINE_PASSWORD_HASH/, /does not accept WICKLINE_PASSWORD/, /second factor/, /TRUST_PROXY/, /secure cookies/]) assert.ok(p.some((x) => re.test(x)), re);
  const ok = loadConfig({ EXPOSURE: 'public', WICKLINE_PASSWORD_HASH: HASH, WICKLINE_TOTP_SECRET: 'JBSWY3DPEHPK3PXPJBSWY3DP', TRUST_PROXY: 'true' });
  assert.equal(ok.trustProxy, 1);
  assert.equal(ok.allowApiTokens, false, 'API tokens are off in public mode unless enabled');
});

test('AUTH_MODE=none needs explicit confirmation and is never public', () => {
  assert.ok(problems({ AUTH_MODE: 'none' }).some((p) => /I_UNDERSTAND_NO_AUTH/.test(p)));
  assert.equal(loadConfig({ AUTH_MODE: 'none', I_UNDERSTAND_NO_AUTH: 'true' }).authMode, 'none');
  assert.ok(problems({ AUTH_MODE: 'none', I_UNDERSTAND_NO_AUTH: 'true', EXPOSURE: 'public' }).some((p) => /requires AUTH_MODE=password/.test(p)));
});

test('test mode is refused in production, redaction hides secrets', () => {
  assert.ok(problems({ WICKLINE_PASSWORD: 'correct horse battery', SELFHOST_TEST_MODE: '1', NODE_ENV: 'production' }).length);
  const r = redacted(loadConfig({ WICKLINE_PASSWORD: 'correct horse battery' }));
  assert.equal(r.password, '[set]');
  assert.ok(!JSON.stringify(r).includes('correct horse'));
});

const req = (headers = {}, { ip = '10.0.0.5', method = 'GET' } = {}) => ({ headers, method, socket: { remoteAddress: `::ffff:${ip}` } });

test('forwarded headers count only behind trusted proxies', () => {
  const r = req({ host: 'nas:5173', 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wl.example.com' });
  assert.deepEqual(clientInfo(r, 0), { ip: '10.0.0.5', proto: 'http', host: 'nas:5173' }, 'untrusted: socket wins');
  assert.deepEqual(clientInfo(r, 1), { ip: '203.0.113.9', proto: 'https', host: 'wl.example.com' }, 'spoofed leftmost entry ignored');
  assert.equal(clientInfo(r, 2).ip, '6.6.6.6');
});

test('same-origin check for state-changing requests', () => {
  const info = { host: 'nas:5173', proto: 'http' };
  assert.ok(sameOrigin(req({}, { method: 'GET' }), info));
  assert.ok(sameOrigin(req({ origin: 'http://nas:5173' }, { method: 'POST' }), info));
  assert.ok(!sameOrigin(req({ origin: 'http://evil.example' }, { method: 'POST' }), info));
  assert.ok(!sameOrigin(req({ origin: 'https://nas:5173' }, { method: 'POST' }), info), 'scheme must match');
  assert.ok(!sameOrigin(req({}, { method: 'POST' }), info), 'no Origin/Referer');
  assert.ok(!sameOrigin(req({ origin: 'null' }, { method: 'POST' }), info));
  assert.ok(sameOrigin(req({ referer: 'http://nas:5173/x' }, { method: 'DELETE' }), info));
});

test('post-login redirects stay on this site', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '/a\r\nSet-Cookie: x=1', '/selfhost/login?next=/',
    '/\t/evil.com', '/\n/evil.com', '/ /evil.com', '/\x00/evil.com', '/a\\b', '/./selfhost/login']) assert.equal(safeNext(bad), '/', JSON.stringify(bad));
  assert.equal(safeNext('/?s=AAPL'), '/?s=AAPL');
  assert.equal(safeNext('/a/../b?x=1'), '/b?x=1', 'normalised, still local');
  assert.equal(safeNext('/%2F/evil.com/..'), '/%2F/', 'an encoded slash stays a path segment, never a host');
});

test('cookies parse and serialize with safe defaults', () => {
  assert.deepEqual(parseCookies('a=1; wl_session=abc%3D; a=2; bad'), { a: '1', wl_session: 'abc=' });
  const c = serializeCookie('wl_session', 'v', { maxAgeSec: 60, secure: true });
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=60', 'Path=/']) assert.ok(c.includes(part), part);
});

test('stripCors removes access-control headers in every writeHead/setHeader form', () => {
  const sent = [];
  const fake = () => {
    const h = new Map();
    return {
      setHeader: (k, v) => { h.set(k.toLowerCase(), v); },
      getHeaderNames: () => [...h.keys()],
      removeHeader: (k) => h.delete(k.toLowerCase()),
      writeHead: (status, ...args) => { sent.push({ status, args, kept: [...h.keys()] }); },
    };
  };
  let r = stripCors(fake());
  r.setHeader('Access-Control-Allow-Origin', '*'); r.setHeader('X-Other', '1');
  r.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'x' });
  assert.deepEqual(sent.at(-1).args[0], { 'Content-Type': 'x' });
  assert.deepEqual(sent.at(-1).kept, ['x-other']);
  r = stripCors(fake());
  r.writeHead(200, 'OK', ['Access-Control-Allow-Origin', '*', 'A', 'b']);
  assert.deepEqual(sent.at(-1).args, ['OK', ['A', 'b']]);
  r = stripCors(fake());
  r.writeHead(204, [['access-control-allow-methods', 'GET'], ['B', 'c']]);
  assert.deepEqual(sent.at(-1).args[0], [['B', 'c']]);
});
