// Server-side alerts end to end: the real server and alert worker thread, a fake upstream Yahoo
// relay (injected as upstream) and a fake Gotify. A crossing fires with no browser open, is
// written into the alerts value, and is pushed once; progress survives a restart (gap).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSelfhost, loopbackBase } from '../../server.mjs';
import { loadConfig } from '../../config.mjs';
import { silentLogger } from '../../log.mjs';

const PASSWORD = 'correct horse battery staple';
const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

/** A fake upstream: its request handler serves /api/yahoo/stream from `relay` and 404s the rest. */
function fakeUpstream(relay) {
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/yahoo/stream') { res.writeHead(404); return res.end(); }
    relay.requests.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 3000\n\n');
    const s = { symbols: new Set(url.searchParams.get('symbols').split(',')), res };
    relay.streams.add(s);
    req.on('close', () => relay.streams.delete(s));
  };
  return { startServer: async () => { const server = http.createServer(handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); return { server }; } };
}
const newRelay = () => {
  const relay = { streams: new Set(), requests: [] };
  relay.send = (tick) => { for (const s of relay.streams) if (s.symbols.has(tick.s)) s.res.write(`data: ${JSON.stringify(tick)}\n\n`); };
  relay.watching = (sym) => [...relay.streams].some((s) => s.symbols.has(sym));
  return relay;
};

async function fakeGotify() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { requests.push(JSON.parse(raw || '{}')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":1}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function start(dir, relay, env = {}) {
  const app = await startSelfhost(loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, WICKLINE_PASSWORD: PASSWORD, ...env }), { log: silentLogger(), upstream: fakeUpstream(relay) });
  const base = `http://127.0.0.1:${app.port}`;
  const r = await fetch(`${base}/selfhost/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams({ password: PASSWORD }).toString() });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  const state = async () => (await fetch(`${base}/api/selfhost/state`, { headers: { cookie } })).json();
  const put = async (alerts, baseVersion) => {
    const { epoch } = await state();
    return fetch(`${base}/api/selfhost/state/alerts`, { method: 'PUT', headers: { origin: base, cookie, 'x-wickline-selfhost': '1', 'content-type': 'application/json' }, body: JSON.stringify({ value: JSON.stringify(alerts), baseVersion, epoch }) });
  };
  const alerts = async () => { const s = await state(); return s.keys.alerts ? { ver: s.keys.alerts.ver, items: JSON.parse(s.keys.alerts.v) } : null; };
  return { app, base, cookie, put, alerts };
}

const newDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'wl-alerts-api-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d; };
const armed = { id: 'k1', symbol: 'YAHOO:AAPL', condition: 'up', price: 200, message: 'buy', active: true, created: 1 };

test('a crossing fires on the server with no browser open, is synced, and pushed once', async () => {
  const g = await fakeGotify();
  const relay = newRelay();
  const ctx = await start(newDir(), relay, { GOTIFY_URL: g.url, GOTIFY_TOKEN: 'tok', PUBLIC_URL: 'https://wl.example' });
  cleanup.push(() => ctx.app.close());
  assert.equal((await ctx.put([armed], 0)).status, 200);
  await until(() => relay.watching('AAPL'));
  assert.match(relay.requests[0]['x-wickline-internal'], /^[0-9a-f]{64}$/);
  relay.send({ s: 'AAPL', p: 199.5, m: 1 });
  relay.send({ s: 'AAPL', p: 200.25, m: 1 });
  await until(async () => (await ctx.alerts()).items[0].active === false);
  const { items, ver } = await ctx.alerts();
  assert.equal(items[0].triggerPrice, 200.25);
  assert.equal(typeof items[0].triggeredAt, 'number');
  assert.equal(ver, 2);
  await until(() => g.requests.length === 1);
  assert.equal(g.requests[0].title, 'AAPL crossing up 200');
  assert.equal(g.requests[0].message, 'Now 200.25 · buy');
  // More ticks, and a browser reporting the same crossing late: still one push.
  relay.send({ s: 'AAPL', p: 199, m: 1 });
  relay.send({ s: 'AAPL', p: 201, m: 1 });
  await ctx.put([{ ...armed, active: false, triggeredAt: Date.now(), triggerPrice: 200.3 }], 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(g.requests.length, 1);
  assert.equal((await ctx.alerts()).items[0].triggerPrice, 200.25);
  await until(() => !relay.watching('AAPL'), 3000); // a fired alert is no longer watched
  const st = await (await fetch(`${ctx.base}/api/selfhost/alerts/status`, { headers: { cookie: ctx.cookie } })).json();
  assert.equal(st.enabled, true);
  assert.equal(st.running, true);
});

test('the internal credential works only from this host, only for the market-data routes', async () => {
  const relay = newRelay();
  const ctx = await start(newDir(), relay);
  cleanup.push(() => ctx.app.close());
  for (const p of ['/api/yahoo/stream?symbols=AAPL', '/api/selfhost/state', '/api/health']) {
    const r = await fetch(`${ctx.base}${p}`, { headers: { 'x-wickline-internal': 'f'.repeat(64) } });
    assert.equal(r.status, 403, p);
  }
  assert.equal(loopbackBase('0.0.0.0', 80), 'http://127.0.0.1:80');
  assert.equal(loopbackBase('::', 80), 'http://[::1]:80');
  assert.equal(loopbackBase('192.168.1.5', 80), 'http://192.168.1.5:80');
});

test('progress survives a restart: a crossing during the downtime fires once, noted as a gap', async () => {
  const g = await fakeGotify();
  const dir = newDir();
  const relay = newRelay();
  const env = { GOTIFY_URL: g.url, GOTIFY_TOKEN: 'tok' };
  const one = await start(dir, relay, env);
  await one.put([armed], 0);
  await until(() => relay.watching('AAPL'));
  relay.send({ s: 'AAPL', p: 199, m: 1 });
  await new Promise((r) => setTimeout(r, 200));
  await one.app.close(); // flushes the worker's progress
  const relay2 = newRelay();
  const two = await start(dir, relay2, env);
  cleanup.push(() => two.app.close());
  await until(() => relay2.watching('AAPL'));
  relay2.send({ s: 'AAPL', p: 201, m: 1 });
  await until(() => g.requests.length === 1);
  assert.equal(g.requests[0].message, 'Now 201 (crossed while Wickline was restarting) · buy');
});

test('ALERTS_SERVER=false runs no worker', async () => {
  const relay = newRelay();
  const ctx = await start(newDir(), relay, { ALERTS_SERVER: 'false' });
  cleanup.push(() => ctx.app.close());
  await ctx.put([armed], 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(relay.streams.size, 0);
  const st = await (await fetch(`${ctx.base}/api/selfhost/alerts/status`, { headers: { cookie: ctx.cookie } })).json();
  assert.deepEqual(st, { enabled: false });
});
