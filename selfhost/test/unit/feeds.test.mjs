// Phase 3d: crypto sources against a fake WebSocket, the REST fallback with rate limits, and the
// per-symbol schedule (market hours, fallback polling, stale episodes) on a fake clock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { keepOpen } from '../../alerts/sources/socket.mjs';
import { createBinanceSource, createCoinbaseSource, createBybitSource, createOkxSource, createCryptoRest, RateLimited } from '../../alerts/sources/crypto.mjs';
import { createFeeds, route, chartOpen } from '../../alerts/feeds.mjs';
import { assignShards } from '../../alerts/sources/shards.mjs';
import { normalizeSymbol } from '../../alerts/evaluate.mjs';
import { createNet } from '../../alerts/net.mjs';
import { createAlertSupervisor } from '../../alerts/supervisor.mjs';
import http from 'node:http';
import netmod from 'node:net';
import { createAlertLedger } from '../../alerts/ledger.mjs';

const cleanup = [];
after(() => { for (const fn of cleanup) fn(); });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const settle = () => new Promise((r) => setImmediate(r));

/** A fake WebSocket: records instances; the test opens, messages and closes them. */
function fakeWs() {
  const sockets = [];
  const openWs = (url) => {
    const ws = { url, sent: [], closed: false, send(m) { this.sent.push(JSON.parse(m)); }, close() { if (this.closed) return; this.closed = true; this.onclose?.(); } };
    ws.open = () => ws.onopen?.();
    ws.message = (obj) => ws.onmessage?.({ data: JSON.stringify(obj) });
    sockets.push(ws);
    return ws;
  };
  return { sockets, openWs };
}

test('routes symbols to their market; crypto tickers match in any case', () => {
  assert.deepEqual(route('YAHOO:AAPL'), { market: 'YAHOO', ticker: 'AAPL' });
  assert.deepEqual(route('binance:btcusdt'), { market: 'BINANCE', ticker: 'BTCUSDT' });
  assert.equal(normalizeSymbol('coinbase:btc-usd'), 'COINBASE:BTC-USD');
  assert.equal(normalizeSymbol('YAHOO:eurusd=X'), 'YAHOO:eurusd=X', 'Yahoo tickers are left alone');
  assert.deepEqual(route('BINANCEF:BTCUSDT'), { market: 'BINANCEF', ticker: 'BTCUSDT' });
  assert.equal(route('KRAKEN:XBTUSD'), null);
});

test('a kept-open socket rotates hosts after a drop and reopens a silent connection', async () => {
  const { sockets, openWs } = fakeWs();
  const conn = keepOpen({ urls: () => ['wss://a', 'wss://b'], openWs, onMessage() {}, silenceMs: 150 });
  cleanup.push(() => conn.close());
  sockets[0].open();
  assert.equal(conn.connected, true);
  sockets[0].close(); // dropped: the next attempt uses the next host after 1 s
  await until(() => sockets.length === 2, 3000);
  assert.equal(sockets[1].url, 'wss://b');
  sockets[1].open();
  await until(() => sockets[1].closed, 2000); // no message for 150 ms: closed by the watchdog
  conn.close();
});

test('Binance: miniTicker streams sharded per connection, prices parsed', async () => {
  const { sockets, openWs } = fakeWs();
  const ticks = [];
  const src = createBinanceSource({ market: 'BINANCEF', openWs, onTick: (t) => ticks.push(t), perConn: 2 });
  cleanup.push(() => src.close());
  src.setSymbols(['ETHUSDT', 'BTCUSDT', 'SOLUSDT']);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].url, 'wss://fstream.binance.com/market/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker');
  sockets[0].open();
  sockets[0].message({ stream: 'btcusdt@miniTicker', data: { s: 'BTCUSDT', c: '64000.5', o: '63000' } });
  sockets[0].message({ data: { s: 'BTCUSDT', c: 'not a number' } });
  assert.deepEqual(ticks.map((t) => [t.symbol, t.price, t.session]), [['BINANCEF:BTCUSDT', 64000.5, 1]]);
  src.setSymbols(['BTCUSDT', 'ETHUSDT']); // the first shard is unchanged; the second goes away
  assert.equal(sockets[0].closed, false);
  assert.equal(sockets[1].closed, true);
  assert.deepEqual(src.status(), { streams: 1, connected: 1, symbols: 2 });
});

test('Coinbase: subscribes to ticker and heartbeat; only tickers are prices', () => {
  const { sockets, openWs } = fakeWs();
  const ticks = [];
  const src = createCoinbaseSource({ openWs, onTick: (t) => ticks.push(t) });
  cleanup.push(() => src.close());
  src.setSymbols(['BTC-USD']);
  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [{ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] }]);
  sockets[0].message({ type: 'heartbeat', product_id: 'BTC-USD' });
  sockets[0].message({ type: 'ticker', product_id: 'BTC-USD', price: '64001.25' });
  assert.deepEqual(ticks.map((t) => [t.symbol, t.price]), [['COINBASE:BTC-USD', 64001.25]]);
});

const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });

test('crypto REST: upstream\'s ticker endpoints, host rotation, and Retry-After on 429/418', async () => {
  const urls = [];
  let answer = (url) => (url.includes('data-api') ? res(500, {}) : res(200, [{ symbol: 'BTCUSDT', lastPrice: '64000' }, { symbol: 'OTHER', lastPrice: '1' }]));
  const restApi = createCryptoRest({ fetch: async (url) => { urls.push(url); return answer(url); } });
  const p = await restApi.fetchPrices('BINANCE', ['BTCUSDT']);
  assert.deepEqual([...p], [['BTCUSDT', 64000]]);
  assert.match(urls[0], /^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/24hr\?type=MINI&symbols=/);
  assert.match(urls[1], /^https:\/\/api\.binance\.com\//, 'the second host after a failure');
  answer = () => res(429, {}, { 'retry-after': '7' });
  await assert.rejects(restApi.fetchPrices('BINANCEF', ['BTCUSDT']), (e) => e instanceof RateLimited && e.waitMs === 7000);
  answer = () => res(418, {});
  await assert.rejects(restApi.fetchPrices('BINANCE', ['BTCUSDT']), (e) => e.waitMs === 120_000);
  answer = (url) => res(200, { last: url.includes('ETH') ? '3000.5' : '64000' });
  assert.deepEqual([...await restApi.fetchPrices('COINBASE', ['ETH-USD'])], [['ETH-USD', 3000.5]]);
  assert.equal(urls.at(-1), 'https://api.exchange.coinbase.com/products/ETH-USD/stats');
});

/** Feeds with fake sources, a fake REST and a fake clock. */
function harness({ open = true, prices = () => new Map(), pollMs = 30_000 } = {}) {
  const clock = { t: 1_000_000 };
  const calls = { prices: [], marketOpen: [] };
  const got = [];
  const stale = [];
  const source = () => ({ setSymbols() {}, close() {}, status: () => ({}) });
  const rest = {
    prices: async (market, tickers) => { calls.prices.push([market, tickers]); return prices(market, tickers); },
    marketOpen: async (ticker) => { calls.marketOpen.push(ticker); return typeof open === 'function' ? open() : open; },
  };
  const feeds = createFeeds({ sources: { YAHOO: source(), BINANCE: source(), BINANCEF: source(), COINBASE: source() }, rest, onPrice: (p) => got.push(p), onStale: (s, since) => stale.push([s, since]), pollMs, closedPollMs: 15 * 60_000, now: () => clock.t });
  const advance = async (ms) => { clock.t += ms; feeds.step(); await settle(); await settle(); };
  return { feeds, clock, calls, got, stale, advance };
}
const MIN = 60_000;

test('live symbols are never polled', async () => {
  const h = harness();
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  for (let i = 0; i < 10; i++) { h.feeds.tick({ symbol: 'BINANCE:BTCUSDT', price: 1, session: 1, at: h.clock.t }); await h.advance(MIN); }
  assert.equal(h.calls.prices.length, 0);
  assert.equal(h.feeds.status().live, 1);
});

test('a crypto stream silent for 5 min falls back to REST every poll interval', async () => {
  const h = harness({ prices: () => new Map([['BTCUSDT', 64000]]) });
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  await h.advance(4 * MIN);
  assert.equal(h.calls.prices.length, 0, 'not yet');
  await h.advance(1 * MIN);
  assert.deepEqual(h.calls.prices, [['BINANCE', ['BTCUSDT']]]);
  assert.deepEqual(h.got.map((p) => [p.symbol, p.price, p.source, p.session]), [['BINANCE:BTCUSDT', 64000, 'poll', 1]]);
  await h.advance(10_000);
  assert.equal(h.calls.prices.length, 1, 'waits for the poll interval');
  await h.advance(20_000);
  assert.equal(h.calls.prices.length, 2);
  assert.equal(h.feeds.status().symbolStates[0].state, 'fallback');
  h.feeds.tick({ symbol: 'BINANCE:BTCUSDT', price: 64001, session: 1, at: h.clock.t }); // the stream is back
  await h.advance(MIN);
  assert.equal(h.calls.prices.length, 2);
});

test('a closed market is not stale and not polled; it is re-checked every closed interval', async () => {
  let open = false;
  const h = harness({ open: () => open, prices: () => new Map([['AAPL', 190]]) });
  h.feeds.setSymbols(['YAHOO:AAPL']);
  await h.advance(10 * MIN);
  assert.deepEqual(h.calls.marketOpen, ['AAPL']);
  await h.advance(MIN);
  assert.equal(h.feeds.status().closed, 1);
  assert.equal(h.calls.prices.length, 0);
  assert.equal(h.stale.length, 0);
  await h.advance(10 * MIN);
  assert.equal(h.calls.marketOpen.length, 1, 'closed answers are trusted for the closed interval');
  open = true;
  await h.advance(5 * MIN);
  assert.equal(h.calls.marketOpen.length, 2);
  await h.advance(10_000);
  assert.deepEqual(h.calls.prices.at(-1), ['YAHOO', ['AAPL']]);
});

test('no price from the stream or REST while open: one stale notice per episode', async () => {
  let failing = true;
  const h = harness({ prices: () => { if (failing) throw new Error('down'); return new Map([['ETH-USD', 3000]]); } });
  h.feeds.setSymbols(['COINBASE:ETH-USD']);
  for (let i = 0; i < 6; i++) await h.advance(MIN);
  for (let i = 0; i < 10; i++) await h.advance(30_000);
  assert.equal(h.stale.length, 1);
  assert.equal(h.stale[0][0], 'COINBASE:ETH-USD');
  assert.equal(h.feeds.status().stale, 1);
  assert.equal(h.feeds.status().symbolStates[0].fallbackError, 'down');
  failing = false;
  await h.advance(30_000);
  assert.equal(h.feeds.status().fallback, 1, 'REST prices end the episode');
  failing = true;
  for (let i = 0; i < 12; i++) await h.advance(30_000);
  assert.equal(h.stale.length, 2, 'a new episode, a new notice');
});

test('a rate-limited market is not polled again until it says', async () => {
  const h = harness({ prices: () => { throw new RateLimited(429, 3 * MIN); } });
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  await h.advance(5 * MIN);
  assert.equal(h.calls.prices.length, 1);
  for (let i = 0; i < 5; i++) await h.advance(30_000);
  assert.equal(h.calls.prices.length, 1, 'still backing off');
  await h.advance(30_000);
  assert.equal(h.calls.prices.length, 2);
});

test('the stale notice is queued once per episode', () => {
  const queued = [];
  const outbox = { enqueue: (k, p) => queued.push([k, p]), insert: () => 0, kick() {} };
  const db = { prepare: () => ({ get() {}, run() {}, all: () => [] }) };
  const ledger = createAlertLedger(db, { outbox, publicUrl: 'https://w.example' });
  ledger.staleNotice('YAHOO:AAPL', 7_200_123);
  ledger.staleNotice('YAHOO:AAPL', 7_300_000); // the same outage seen again after a worker restart
  assert.equal(queued[0][0], 'stale:YAHOO:AAPL:2');
  assert.equal(queued[1][0], 'stale:YAHOO:AAPL:2', 'same key: the outbox sends it once');
  assert.equal(queued[0][1].title, 'No prices for AAPL');
  assert.equal(queued[0][1].url, 'https://w.example/#s=YAHOO%3AAAPL');
});

test('market open: a 1-minute bar from the last 15 minutes, in exchange-local time', () => {
  const now = Date.UTC(2026, 10, 27, 15, 0, 0); // 10:00 New York
  const tz = -5 * 3600;
  const bar = (minAgo) => ({ time: now / 1000 + tz - minAgo * 60 });
  assert.equal(chartOpen({ meta: { tzOffset: tz }, bars: [bar(30), bar(1)] }, now), true);
  assert.equal(chartOpen({ meta: { tzOffset: tz }, bars: [bar(16)] }, now), false);
  assert.equal(chartOpen({ meta: { tzOffset: tz }, bars: [] }, now), false, 'a holiday: no bars today');
  assert.equal(chartOpen(null, now), false);
});

test('stable shards: one added or removed symbol changes at most one shard', () => {
  const a = ['AAA', 'BBB'];
  const b = ['CCC', 'DDD'];
  const added = assignShards([a, b], ['AAA', 'AAB', 'BBB', 'CCC', 'DDD'], 3);
  assert.equal(added.filter((g) => g !== a && g !== b).length, 1);
  assert.ok(added.includes(b) || added.includes(a), 'the other shard is untouched');
  const removed = assignShards([a, b], ['AAA', 'BBB', 'CCC'], 3);
  assert.ok(removed.includes(a));
  assert.deepEqual(removed.flat().sort(), ['AAA', 'BBB', 'CCC']);
  assert.deepEqual(assignShards([], ['C', 'A', 'B', 'D', 'E'], 2).map((g) => g.length).sort(), [1, 2, 2]);
});

test('Binance: arming one more symbol reconnects one shard, not every later one', () => {
  const { sockets, openWs } = fakeWs();
  const src = createBinanceSource({ market: 'BINANCE', openWs, onTick() {}, perConn: 2 });
  cleanup.push(() => src.close());
  src.setSymbols(['AAA', 'BBB', 'CCC']);
  const before = sockets.length;
  src.setSymbols(['AAA', 'AAB', 'BBB', 'CCC']);
  assert.equal(sockets.length - before, 1, 'one new connection');
  assert.equal(sockets.filter((w) => w.closed).length, 1, 'one closed');
});

test('after a failed fallback and a stream recovery, a working fallback sends no stale notice', async () => {
  let failing = true;
  const h = harness({ prices: () => { if (failing) throw new Error('down'); return new Map([['BTCUSDT', 64000]]); } });
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  for (let i = 0; i < 24; i++) await h.advance(30_000); // first outage: stale once
  assert.equal(h.stale.length, 1);
  h.feeds.tick({ symbol: 'BINANCE:BTCUSDT', price: 64000, session: 1, at: h.clock.t }); // the stream is back
  assert.equal(h.feeds.status().symbolStates[0].fallbackError, undefined);
  failing = false;
  for (let i = 0; i < 24; i++) await h.advance(30_000); // quiet again, the fallback works
  assert.equal(h.stale.length, 1, 'no second, false notice');
});

test('crypto REST: a total futures or Coinbase outage is an error, not "no price"', async () => {
  const restApi = createCryptoRest({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(restApi.fetchPrices('BINANCEF', ['BTCUSDT', 'ETHUSDT']), /ECONNREFUSED/);
  await assert.rejects(restApi.fetchPrices('COINBASE', ['BTC-USD']), /ECONNREFUSED/);
});

test('Binance futures use the /market/stream path (upstream\'s /stream is silent)', async () => {
  const { BINANCE } = await import('../../alerts/sources/crypto.mjs');
  assert.equal(BINANCE.BINANCEF.wsPath, '/market/stream');
  assert.equal(BINANCE.BINANCE.wsPath, '/stream');
});

test('a working fallback sends no stale notice when the stream goes quiet', async () => {
  const h = harness({ prices: () => new Map([['BTCUSDT', 64000]]) });
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  for (let i = 0; i < 20; i++) await h.advance(30_000);
  assert.equal(h.stale.length, 0);
  assert.equal(h.feeds.status().fallback, 1);
});

test('a REST price that comes back after a newer streamed tick is not evaluated', async () => {
  let release;
  const h = harness({ prices: () => new Promise((r) => { release = () => r(new Map([['BTCUSDT', 99]])); }) });
  h.feeds.setSymbols(['BINANCE:BTCUSDT']);
  await h.advance(5 * 60_000); // the poll goes out
  h.feeds.tick({ symbol: 'BINANCE:BTCUSDT', price: 101, session: 1, at: h.clock.t + 1 }); // the stream is back first
  h.clock.t += 2;
  release();
  await settle(); await settle();
  assert.deepEqual(h.got.map((p) => [p.source, p.price]), [['stream', 101]]);
});

test('a failing market check after a "closed" answer assumes open, so the fallback runs', async () => {
  let mode = 'closed';
  const h = harness({ open: () => { if (mode === 'fail') throw new Error('chart down'); return false; }, prices: () => new Map([['AAPL', 190]]) });
  h.feeds.setSymbols(['YAHOO:AAPL']);
  await h.advance(10 * 60_000);
  await h.advance(10_000);
  assert.equal(h.feeds.status().closed, 1);
  mode = 'fail';
  await h.advance(15 * 60_000); // the closed answer expires; the re-check fails
  await h.advance(30_000);
  assert.ok(h.calls.prices.length >= 1, 'polled');
  assert.equal(h.feeds.status().closed, 0);
});

test('the Yahoo fallback polls every quiet symbol, in batches of 200', async () => {
  const h = harness({ prices: (m, tickers) => new Map(tickers.map((t) => [t, 1])) });
  h.feeds.setSymbols(Array.from({ length: 450 }, (_, i) => `BINANCE:S${i}USDT`));
  await h.advance(5 * 60_000);
  assert.equal(h.calls.prices.length, 1, 'crypto: one request per market');
  const y = harness({ open: true, prices: (m, tickers) => new Map(tickers.map((t) => [t, 1])) });
  y.feeds.setSymbols(Array.from({ length: 450 }, (_, i) => `YAHOO:S${i}`));
  await y.advance(10 * 60_000); // quiet: market checks start (2 per step)
  for (let i = 0; i < 240; i++) await y.advance(5_000);
  const sizes = y.calls.prices.map(([, t]) => t.length);
  assert.ok(sizes.every((n) => n <= 200), 'no batch above 200');
  const polled = new Set(y.calls.prices.flatMap(([, t]) => t));
  assert.equal(polled.size, 450, 'none starved');
});

test('crypto REST: futures one request per symbol; Coinbase tolerates one failing product', async () => {
  const urls = [];
  const restApi = createCryptoRest({
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('BAD')) return res(404, {});
      if (url.includes('fapi')) return res(200, { symbol: new URL(url).searchParams.get('symbol'), lastPrice: '5' });
      return res(200, { last: '7' });
    },
  });
  const f = await restApi.fetchPrices('BINANCEF', ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual([...f].sort(), [['BTCUSDT', 5], ['ETHUSDT', 5]]);
  assert.ok(urls.every((u) => /ticker\/24hr\?symbol=/.test(u)), 'never the full list');
  const c = await restApi.fetchPrices('COINBASE', ['BAD-USD', 'ETH-USD']);
  assert.deepEqual([...c], [['ETH-USD', 7]]);
});

test('net: loopback goes direct; exchanges go through WICKLINE_PROXY', async () => {
  const hits = { target: 0, proxy: 0 };
  const target = http.createServer((req, res) => { hits.target++; res.end('direct'); });
  // undici tunnels through an HTTP proxy with CONNECT: count the tunnels and relay them.
  const proxy = http.createServer((req, res) => { res.statusCode = 405; res.end(); });
  proxy.on('connect', (req, client, head) => {
    hits.proxy++;
    const [host, port] = req.url.split(':');
    const up = netmod.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => { target.closeAllConnections(); target.close(); proxy.closeAllConnections(); proxy.close(); });
  const net = createNet({ proxyUrl: `http://127.0.0.1:${proxy.address().port}` });
  const url = `http://127.0.0.1:${target.address().port}/x`;
  assert.equal(await (await net.loopback(url)).text(), 'direct');
  assert.equal(await (await net.fetch(url)).text(), 'direct');
  assert.deepEqual(hits, { target: 2, proxy: 1 }, 'the second request went through the proxy');
  await net.close();
});

test('the supervisor forwards stale notices to the ledger only with NOTIFY_STALE', async () => {
  const src = "import { parentPort } from 'node:worker_threads';"
    + "parentPort.postMessage({ type: 'stale', symbol: 'YAHOO:AAPL', since: 5 });"
    + "setInterval(() => parentPort.postMessage({ type: 'heartbeat', status: {} }), 50);";
  const url = new URL(`data:text/javascript,${encodeURIComponent(src)}`);
  for (const notifyStale of [false, true]) {
    const notices = [];
    const ledger = { resumePoints: () => ({}), trigger: () => ({ fired: false }), saveProgress() {}, staleNotice: (s, since) => notices.push([s, since]) };
    const sync = { snapshot: () => ({ keys: {} }), onChange: () => () => {} };
    const lines = [];
    const log = { warn: (msg) => lines.push(msg), info() {}, error() {}, debug() {} };
    const sup = createAlertSupervisor({ ledger, sync, log, notifyStale, workerData: {}, workerUrl: url });
    sup.start();
    await until(() => lines.some((l) => l.startsWith('no prices')));
    await sup.stop();
    assert.deepEqual(notices, notifyStale ? [['YAHOO:AAPL', 5]] : []);
  }
});

test('Bybit: tickers topics 10 per subscribe, a ping, and only updates that carry a price', async () => {
  const { sockets, openWs } = fakeWs();
  const ticks = [];
  const src = createBybitSource({ market: 'BYBITF', openWs, onTick: (t) => ticks.push(t) });
  cleanup.push(() => src.close());
  const tickers = Array.from({ length: 12 }, (_, i) => `C${String(i).padStart(2, '0')}USDT`);
  src.setSymbols(tickers);
  assert.equal(sockets[0].url, 'wss://stream.bybit.com/v5/public/linear');
  sockets[0].open();
  assert.deepEqual(sockets[0].sent.map((m) => m.args.length), [10, 2]);
  assert.equal(sockets[0].sent[0].op, 'subscribe');
  assert.equal(sockets[0].sent[0].args[0], 'tickers.C00USDT');
  sockets[0].message({ topic: 'tickers.C00USDT', data: { symbol: 'C00USDT', lastPrice: '61000.5' } });
  sockets[0].message({ topic: 'tickers.C00USDT', data: { symbol: 'C00USDT', fundingRate: '0.0001' } }); // a perpetual delta: no price
  assert.deepEqual(ticks.map((t) => [t.symbol, t.price]), [['BYBITF:C00USDT', 61000.5]]);
  const spot = createBybitSource({ market: 'BYBIT', openWs, onTick() {} });
  cleanup.push(() => spot.close());
  spot.setSymbols(['BTCUSDT']);
  assert.equal(sockets.at(-1).url, 'wss://stream.bybit.com/v5/public/spot');
});

test('OKX: tickers channel with -SWAP ids for perpetuals; "pong" and errors are not prices', () => {
  const { sockets, openWs } = fakeWs();
  const ticks = [];
  const src = createOkxSource({ market: 'OKXF', openWs, onTick: (t) => ticks.push(t) });
  cleanup.push(() => src.close());
  src.setSymbols(['BTC-USDT']);
  assert.equal(sockets[0].url, 'wss://ws.okx.com:8443/ws/v5/public');
  sockets[0].open();
  assert.deepEqual(sockets[0].sent, [{ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }] }]);
  sockets[0].onmessage({ data: 'pong' });
  sockets[0].message({ event: 'error', code: '60018', msg: "Invalid instId" });
  sockets[0].message({ arg: { channel: 'tickers', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', last: '60720.4' }] });
  assert.deepEqual(ticks.map((t) => [t.symbol, t.price]), [['OKXF:BTC-USDT', 60720.4]]);
});

test('the kept-open socket sends the exchange ping while connected', async () => {
  const { sockets, openWs } = fakeWs();
  const conn = keepOpen({ urls: () => ['wss://a'], openWs, onMessage() {}, ping: { everyMs: 40, message: () => 'ping' } });
  cleanup.push(() => conn.close());
  sockets[0].sent = [];
  sockets[0].send = (m) => sockets[0].sent.push(m);
  sockets[0].open();
  await until(() => sockets[0].sent.length >= 2);
  conn.close();
  const n = sockets[0].sent.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sockets[0].sent.length, n, 'no ping after close');
});

test('crypto REST: Bybit and OKX tickers, an exchange error counts as a failure', async () => {
  const urls = [];
  const restApi = createCryptoRest({
    fetch: async (url) => {
      urls.push(url);
      if (url.includes('bybit.com') && url.includes('BAD')) return res(200, { retCode: 10001, retMsg: 'params error' });
      if (url.includes('bybit')) return res(200, { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '61000' }] } });
      return res(200, { code: '0', data: [{ instId: 'BTC-USDT-SWAP', last: '60720.4' }] });
    },
  });
  assert.deepEqual([...await restApi.fetchPrices('BYBITF', ['BTCUSDT'])], [['BTCUSDT', 61000]]);
  assert.match(urls.at(-1), /^https:\/\/api\.bybit\.com\/v5\/market\/tickers\?category=linear&symbol=BTCUSDT$/);
  assert.deepEqual([...await restApi.fetchPrices('OKXF', ['BTC-USDT'])], [['BTC-USDT', 60720.4]]);
  assert.equal(urls.at(-1), 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP');
  await assert.rejects(restApi.fetchPrices('BYBIT', ['BAD']), /exchange error/, 'every host refused: an error, not "no price"');
});

test('Bybit and OKX symbols route to their markets', () => {
  assert.deepEqual(route('bybitf:btcusdt'), { market: 'BYBITF', ticker: 'BTCUSDT' });
  assert.deepEqual(route('OKX:BTC-USDT'), { market: 'OKX', ticker: 'BTC-USDT' });
  assert.equal(normalizeSymbol('okxf:btc-usdt'), 'OKXF:BTC-USDT');
});
