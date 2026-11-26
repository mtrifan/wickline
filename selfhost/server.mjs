// Wickline Self-Hosted: entrypoint. Wraps the unmodified upstream server (ADR-001): upstream
// handles the app and its market-data relay; this layer adds security headers, authentication and
// the /api/selfhost/* routes, then delegates everything else to upstream's request handler.
//
//   node selfhost/server.mjs            (configuration: environment variables, see SELFHOSTED.md)

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { injectBoot, isIndexPath } from './http/inject.mjs';
import { clientKeyConfig } from './sync/key-policy.mjs';
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
import { createSyncState } from './sync/state.mjs';
import { createEventHub } from './sync/events.mjs';
import { createSyncRoutes } from './sync/routes.mjs';
import { createAdminRoutes } from './http/admin.mjs';
import { createNotifyRoutes } from './http/notify.mjs';
import { createGotify } from './notify/gotify.mjs';
import { createOutbox } from './notify/outbox.mjs';
import { createAlertLedger } from './alerts/ledger.mjs';
import { createAlertSupervisor } from './alerts/supervisor.mjs';
import { holdServerLock, startBackupScheduler, sweepTemporaryFiles, DataDirInUseError } from './storage/backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wl_session';
const read = (rel) => { try { return readFileSync(path.join(ROOT, rel), 'utf8').trim(); } catch { return null; } };
export const VERSION = {
  upstream: (() => { try { return JSON.parse(read('package.json')).version; } catch { return null; } })(),
  selfhost: read('selfhost/VERSION'),
};

/** Upstream routes the alert worker reads over loopback with the internal credential. */
const INTERNAL_ROUTES = new Set(['/api/yahoo/stream', '/api/yahoo/quotes', '/api/yahoo/chart']);

/** Where a client on this host reaches a server listening on `host`. */
export function loopbackBase(host, port) {
  const h = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

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
  if (proxy.error) log.warn('ignoring invalid proxy setting (value not logged: it may contain credentials)', { error: proxy.error });
  if (proxy.url) { await proxyMod.setServerProxy(proxy.url); log.info('outbound traffic goes through a proxy', { proxy: proxy.url.replace(/\/\/[^@/]*@/, '//') }); }

  const lock = holdServerLock(cfg.dataDir); // before opening the database; `cli.mjs restore` refuses while it is fresh
  try { // a failed start releases the lock, so the next attempt is not refused
  const { db, version: schema, migrated, backup } = openDatabase(cfg.dataDir, { log });
  const swept = sweepTemporaryFiles(cfg.dataDir);
  if (swept.length) log.info('removed temporary files left by an interrupted download or restore', { files: swept });
  const backups = startBackupScheduler({ db, dataDir: cfg.dataDir, intervalHours: cfg.backupIntervalHours, keep: cfg.backupKeep, log });
  const store = createAuthStore(db, { sessionDays: cfg.sessionDays });
  store.purgeExpired();
  const purgeTimer = setInterval(() => store.purgeExpired(), 3600_000).unref();
  const sync = createSyncState(db, { syncWorkspace: cfg.syncWorkspace, log });
  // Read once: upstream files change only with a new image.
  const indexHtml = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const bootJs = readFileSync(path.join(ROOT, 'selfhost/public/boot.js'));
  const keyConfig = clientKeyConfig({ syncWorkspace: cfg.syncWorkspace });
  const handleAdmin = createAdminRoutes({ state: sync, db, dataDir: cfg.dataDir, version: VERSION, log });
  const providers = [createGotify({ url: cfg.gotifyUrl, token: cfg.gotifyToken, priority: cfg.gotifyPriority })];
  const outbox = createOutbox(db, { providers, maxAttempts: cfg.notifyMaxAttempts, log });
  outbox.start(); // delivers anything queued before a restart
  // The alerts merge and trigger records: a browser trigger is pushed once, from here (PLAN §2.5.6).
  const alerts = createAlertLedger(db, { outbox, publicUrl: cfg.publicUrl, log });
  alerts.attach(sync);
  const handleNotify = createNotifyRoutes({ outbox, publicUrl: cfg.publicUrl });
  const hub = createEventHub(sync);
  const handleSync = createSyncRoutes({
    state: sync,
    hub,
    isValid: (auth) => {
      if (auth?.kind === 'session') return () => store.isSessionValid(auth.token);
      if (auth?.kind === 'token') return () => cfg.allowApiTokens && store.isTokenValid(auth.id);
      return () => cfg.authMode === 'none';
    },
  });

  const passwordHash = cfg.authMode === 'password' ? (cfg.passwordHash || hashPassword(cfg.password)) : null;
  const limiter = createLoginLimiter({ globalSpacingMs: cfg.exposure === 'public' ? 1000 : 0 });

  // Upstream's request handler is captured from startServer() and called in-process; upstream's own
  // listener is closed straight away, so no unauthenticated port stays open (not even on loopback).
  const up = upstream || await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);
  const internal = await up.startServer({ port: 0, host: '127.0.0.1' });
  const [upstreamHandler] = internal.server.listeners('request');
  await new Promise((r) => internal.server.close(() => r()));
  if (typeof upstreamHandler !== 'function') throw new Error('Upstream server has no request handler (integration point server-start)');

  const internalToken = randomBytes(32);
  const internalHex = internalToken.toString('hex');
  function isInternal(req, url) {
    const given = Buffer.from(String(req.headers['x-wickline-internal']), 'utf8');
    const sameHost = !!req.socket.remoteAddress && req.socket.remoteAddress === req.socket.localAddress;
    const tokenOk = given.length === internalHex.length && timingSafeEqual(given, Buffer.from(internalHex));
    return tokenOk && sameHost && req.method === 'GET' && INTERNAL_ROUTES.has(url.pathname);
  }

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
    const form = await readForm(req, 16 * 1024);
    const next = safeNext(form.next);
    // Checked after the last await: from here to limiter.fail() everything is synchronous (scrypt
    // included), so parallel attempts cannot all pass the check before a failure is recorded.
    const wait = limiter.retryAfter(info.ip);
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
    if (auth?.kind === 'session') { store.deleteSession(auth.token); hub.dropSession(auth.token); }
    store.audit('logout', { ip: info.ip });
    return redirect(res, '/selfhost/login', { 'Set-Cookie': serializeCookie(COOKIE, '', { maxAgeSec: 0, secure: cookieSecure(info) }) });
  }

  async function handle(req, res) {
    const info = clientInfo(req, cfg.trustProxy, cfg.isTrustedProxy);
    stripCors(res);
    securityHeaders(res, { hsts: cfg.exposure === 'public' });

    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const route = `${req.method} ${url.pathname}`;

    // The alert worker reading upstream's market data. Only from this host (the socket's two ends
    // share an address), only GET on INTERNAL_ROUTES, and only with the per-process credential,
    // which never leaves this process.
    if (req.headers['x-wickline-internal'] !== undefined) {
      if (!isInternal(req, url)) return sendJson(res, 403, { error: 'Forbidden' });
      return upstreamHandler(req, res);
    }

    if (route === 'GET /api/health/ready' || route === 'HEAD /api/health/ready') {
      let dbOk = false;
      try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { /* not ready */ }
      const ok = state.ready && !state.shuttingDown && dbOk;
      return sendJson(res, ok ? 200 : 503, { ok });
    }

    // Public mode: refuse anything that did not arrive over HTTPS at the trusted proxy.
    if (cfg.exposure === 'public' && info.proto !== 'https') return sendJson(res, 403, { error: 'HTTPS required' });

    // A Bearer token is its own CSRF defence: browsers never attach one by themselves, and a
    // cross-site script cannot send one (the CORS preflight fails). Scripts need no Origin header.
    const bearer = cfg.authMode === 'password' && cfg.allowApiTokens && String(req.headers.authorization || '').startsWith('Bearer ');
    if (!bearer && !sameOrigin(req, info)) return sendJson(res, 403, { error: 'Cross-origin request refused' });

    if (url.pathname === '/selfhost/login' && (req.method === 'GET' || req.method === 'POST')) return handleLogin(req, res, info);

    // Defence in depth for the JSON API: a header a cross-site form cannot send.
    if (url.pathname.startsWith('/api/selfhost/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-wickline-selfhost'] !== '1') {
      return sendJson(res, 403, { error: 'Missing X-Wickline-Selfhost header' });
    }

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
    if ((req.method === 'GET' || req.method === 'HEAD') && isIndexPath(url.pathname)) {
      const html = injectBoot(indexHtml, { ...sync.snapshot(), sync: keyConfig });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/selfhost/boot.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': bootJs.length });
      return res.end(req.method === 'HEAD' ? undefined : bootJs);
    }
    if (url.pathname.startsWith('/api/selfhost/') && (await handleSync(req, res, url, auth)) !== false) return undefined;
    if (url.pathname.startsWith('/api/selfhost/') && (await handleAdmin(req, res, url)) !== false) return undefined;
    if (url.pathname.startsWith('/api/selfhost/notify/') && (await handleNotify(req, res, url)) !== false) return undefined;
    if (url.pathname === '/api/selfhost/alerts/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return sendJson(res, 200, supervisor ? { enabled: true, ...supervisor.status() } : { enabled: false });
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
  server.requestTimeout = 60_000; // receiving the request only; long-lived responses (SSE) are unaffected
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  const port = server.address().port;
  // Server-side alerts (PLAN §2.5): a worker thread reads upstream's Yahoo relay over loopback.
  const supervisor = cfg.alertsServer ? createAlertSupervisor({
    ledger: alerts,
    sync,
    log,
    workerData: {
      baseUrl: loopbackBase(cfg.host, port),
      token: internalHex,
      extendedHours: cfg.alertExtendedHours,
      resumeMaxGapMs: cfg.alertResumeMaxGapMin * 60_000,
      maxSymbols: cfg.alertMaxSymbols,
    },
  }) : null;
  supervisor?.start();
  state.ready = true;
  log.info('Wickline Self-Hosted started', { port, host: cfg.host, upstream: VERSION.upstream, selfhost: VERSION.selfhost, schema, migrated, backup, config: redacted(cfg) });
  if (cfg.authMode === 'none') log.warn('AUTHENTICATION IS DISABLED (AUTH_MODE=none). Anyone who can reach this port can use it.');

  let closing = null;
  async function close() {
    if (closing) return closing;
    state.shuttingDown = true;
    closing = (async () => {
      const done = new Promise((r) => server.close(() => r()));
      hub.close();
      backups.stop();
      const workerStopped = supervisor ? supervisor.stop() : null; // stores the latest prices for resuming
      const drained = outbox.stop(); // a send in flight gets up to 5 s
      // Long-lived streams (SSE) never end on their own.
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
      await Promise.all([done, drained, workerStopped]);
      clearInterval(purgeTimer);
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      db.close();
      lock.release();
      log.info('stopped');
    })();
    return closing;
  }

  return { server, port, close, state, db, store, sync, hub, outbox, alerts, supervisor };
  } catch (e) {
    lock.release();
    throw e;
  }
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
    const known = e instanceof DowngradeError || e instanceof DataDirInUseError;
    log.error(known ? e.message : 'startup failed', { error: e });
    process.exit(known ? 78 : 1); // EX_CONFIG: needs the operator, not a restart loop
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
