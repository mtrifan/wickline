// Wickline Self-Hosted: entrypoint. Wraps the unmodified upstream server (ADR-001): upstream
// handles the app and its market-data relay; this layer adds security headers, authentication and
// the /api/selfhost/* routes, then delegates everything else to upstream's request handler.
//
//   node selfhost/server.mjs            (configuration: environment variables, see SELFHOSTED.md)

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, redacted, ConfigError } from './config.mjs';
import { createLogger } from './log.mjs';
import { openDatabase, DowngradeError } from './storage/db.mjs';
import { hashPassword, verifyPassword } from './auth/password.mjs';
import { verifyTotp } from './auth/totp.mjs';
import { createAuthStore } from './auth/store.mjs';
import { createLoginLimiter } from './auth/rate-limit.mjs';
import { clientInfo, parseCookies, serializeCookie, readForm, sameOrigin, safeNext, HttpError } from './http/request.mjs';
import { stripCors, securityHeaders, sendJson, sendHtml, redirect } from './http/headers.mjs';
import { loginPage } from './http/pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wl_session';
const read = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8').trim(); } catch { return null; } };
export const VERSION = {
  upstream: (() => { try { return JSON.parse(read('package.json')).version; } catch { return null; } })(),
  selfhost: read('selfhost/VERSION'),
};

/** Routes reachable without logging in. Everything else, upstream's included, needs a session. */
const PUBLIC_ROUTES = new Set(['GET /api/health/ready', 'HEAD /api/health/ready', 'GET /selfhost/login', 'POST /selfhost/login']);

/**
 * Starts the self-hosted server. Returns { server, port, close(), state }.
 * `upstream` is injectable for tests; by default it is the real upstream server.mjs.
 */
export async function startSelfhost(cfg, { log = createLogger({ level: cfg.logLevel }), upstream } = {}) {
  const state = { ready: false, shuttingDown: false };

  // Outbound proxy for every fetch/WebSocket (same behaviour as `node server.mjs`).
  const proxyMod = await import(pathToFileURL(path.join(ROOT, 'lib/proxy.mjs')).href);
  const proxy = proxyMod.envProxy();
  if (proxy.error) log.warn('ignoring invalid proxy setting', { proxy: proxy.text, error: proxy.error });
  if (proxy.url) { await proxyMod.setServerProxy(proxy.url); log.info('outbound traffic goes through a proxy', { proxy: proxy.url.replace(/\/\/[^@/]*@/, '//') }); }

  const { db, version: schema, migrated, backup } = openDatabase(cfg.dataDir, { log });
  const store = createAuthStore(db, { sessionDays: cfg.sessionDays });
  store.purgeExpired();
  const purgeTimer = setInterval(() => store.purgeExpired(), 3600_000).unref();

  const passwordHash = cfg.authMode === 'password' ? (cfg.passwordHash || hashPassword(cfg.password)) : null;
  const limiter = createLoginLimiter({ globalSpacingMs: cfg.exposure === 'public' ? 1000 : 0 });

  // Upstream runs on an internal loopback listener (used by the background worker in Phase 3);
  // its request handler is captured and called in-process for public requests.
  const up = upstream || await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);
  const internal = await up.startServer({ port: 0, host: '127.0.0.1' });
  const [upstreamHandler] = internal.server.listeners('request');
  if (typeof upstreamHandler !== 'function') throw new Error('Upstream server has no request handler (integration point server-start)');

  const cookieSecure = (info) => cfg.cookieSecure === 'true' || cfg.exposure === 'public' || (cfg.cookieSecure === 'auto' && info.proto === 'https');

  function authenticate(req, info) {
    if (cfg.authMode === 'none') return { kind: 'none' };
    const authz = String(req.headers.authorization || '');
    if (authz.startsWith('Bearer ')) {
      if (!cfg.allowApiTokens) return null;
      const t = store.checkToken(authz.slice(7).trim());
      return t ? { kind: 'token', id: t.id } : null;
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = token && store.getSession(token);
    return s ? { kind: 'session', token } : null;
  }

  async function handleLogin(req, res, info) {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      if (authenticate(req, info)) return redirect(res, safeNext(url.searchParams.get('next')));
      return sendHtml(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')), totp: !!cfg.totpSecret }));
    }
    const wait = limiter.retryAfter(info.ip);
    const form = await readForm(req, 16 * 1024);
    const next = safeNext(form.next);
    const fail = (status, error, retryMs = 0) => sendHtml(res, status, loginPage({ next, totp: !!cfg.totpSecret, error, retryAfterSec: Math.ceil(retryMs / 1000) }),
      retryMs ? { 'Retry-After': String(Math.ceil(retryMs / 1000)) } : {});
    if (wait > 0) return fail(429, 'Too many attempts.', wait);

    let ok = typeof form.password === 'string' && form.password.length <= 1024 && verifyPassword(form.password, passwordHash);
    let counter = null;
    if (ok && cfg.totpSecret) {
      counter = verifyTotp(cfg.totpSecret, form.code, { lastCounter: store.getTotpCounter() });
      ok = counter !== null;
    }
    if (!ok) {
      limiter.fail(info.ip);
      store.audit('login.failure', { ip: info.ip });
      log.warn('login failed', { ip: info.ip });
      return fail(401, cfg.totpSecret ? 'Wrong password or code.' : 'Wrong password.');
    }
    if (counter !== null) store.setTotpCounter(counter);
    limiter.succeed(info.ip);
    const { token } = store.createSession({ userAgent: req.headers['user-agent'], ip: info.ip });
    store.audit('login.success', { ip: info.ip });
    log.info('login', { ip: info.ip });
    const hash = typeof form.hash === 'string' && /^#[A-Za-z0-9._~:/?&=%+,;@!$'()*-]{0,1999}$/.test(form.hash) ? form.hash : '';
    return redirect(res, next + hash, { 'Set-Cookie': serializeCookie(COOKIE, token, { maxAgeSec: cfg.sessionDays * 86400, secure: cookieSecure(info) }) });
  }

  function handleLogout(req, res, info, auth) {
    if (auth?.kind === 'session') store.deleteSession(auth.token);
    store.audit('logout', { ip: info.ip });
    return redirect(res, '/selfhost/login', { 'Set-Cookie': serializeCookie(COOKIE, '', { maxAgeSec: 0, secure: cookieSecure(info) }) });
  }

  async function handle(req, res) {
    const info = clientInfo(req, cfg.trustProxy);
    stripCors(res);
    securityHeaders(res, { hsts: cfg.exposure === 'public' });

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health/ready' || route === 'HEAD /api/health/ready') {
      let dbOk = false;
      try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { /* not ready */ }
      const ok = state.ready && !state.shuttingDown && dbOk;
      return sendJson(res, ok ? 200 : 503, { ok });
    }

    // Public mode: refuse anything that did not arrive over HTTPS at the trusted proxy.
    if (cfg.exposure === 'public' && info.proto !== 'https') return sendJson(res, 403, { error: 'HTTPS required' });

    if (!sameOrigin(req, info)) return sendJson(res, 403, { error: 'Cross-origin request refused' });

    if (url.pathname === '/selfhost/login' && (req.method === 'GET' || req.method === 'POST')) return handleLogin(req, res, info);

    const auth = authenticate(req, info);
    if (!auth && !PUBLIC_ROUTES.has(route)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Authentication required' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 401, { error: 'Authentication required' });
      return redirect(res, `/selfhost/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }

    if (route === 'POST /selfhost/logout') return handleLogout(req, res, info, auth);
    if (route === 'GET /api/selfhost/session') {
      return sendJson(res, 200, { authenticated: true, via: auth.kind, exposure: cfg.exposure, totp: !!cfg.totpSecret, version: VERSION, schema });
    }
    if (url.pathname.startsWith('/api/selfhost/') || url.pathname.startsWith('/selfhost/')) return sendJson(res, 404, { error: 'Not found' });

    // Upstream's app and API (GET only upstream; it answers 405 to anything else).
    return upstreamHandler(req, res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error('request failed', { path: req.url?.slice(0, 200), error: e });
      try { if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error' : e.message }); else res.destroy(); } catch { /* gone */ }
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // SSE streams are long-lived
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  const port = server.address().port;
  state.ready = true;
  log.info('Wickline Self-Hosted started', { port, host: cfg.host, upstream: VERSION.upstream, selfhost: VERSION.selfhost, schema, migrated, backup, config: redacted(cfg) });
  if (cfg.authMode === 'none') log.warn('AUTHENTICATION IS DISABLED (AUTH_MODE=none). Anyone who can reach this port can use it.');

  let closing = null;
  async function close() {
    if (closing) return closing;
    state.shuttingDown = true;
    closing = (async () => {
      const done = Promise.all([
        new Promise((r) => server.close(() => r())),
        new Promise((r) => internal.server.close(() => r())),
      ]);
      // Long-lived streams (SSE) never end on their own.
      server.closeIdleConnections(); internal.server.closeIdleConnections();
      setTimeout(() => { server.closeAllConnections(); internal.server.closeAllConnections(); }, 1000).unref();
      await done;
      clearInterval(purgeTimer);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      db.close();
      log.info('stopped');
    })();
    return closing;
  }

  return { server, port, close, state, db, store };
}

// ---------------------------------------------------------------------------------------------
// `node selfhost/server.mjs`
// ---------------------------------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let cfg;
  try { cfg = loadConfig(); } catch (e) {
    process.stderr.write(`${e instanceof ConfigError ? e.message : e.stack}\n`);
    process.exit(78); // EX_CONFIG: do not restart-loop silently
  }
  const log = createLogger({ level: cfg.logLevel });
  let app;
  try { app = await startSelfhost(cfg, { log }); } catch (e) {
    log.error(e instanceof DowngradeError ? e.message : 'startup failed', { error: e });
    process.exit(e instanceof DowngradeError ? 78 : 1);
  }
  const stop = (signal) => {
    log.info('shutting down', { signal });
    const force = setTimeout(() => { log.error('shutdown timed out; exiting'); process.exit(1); }, cfg.shutdownTimeoutMs);
    force.unref();
    // Upstream keeps timers (stream reconnects, pings) without a stop API: exit explicitly.
    app.close().then(() => process.exit(0), (e) => { log.error('shutdown failed', { error: e }); process.exit(1); });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: e }));
}
