// Phase 3d: crypto sources against a fake WebSocket, the REST fallback with rate limits, and the
// per-symbol schedule (market hours, fallback polling, stale episodes) on a fake clock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { keepOpen } from '../../alerts/sources/socket.mjs';
import { createBinanceSource, createCoinbaseSource, createCryptoRest, RateLimited } from '../../alerts/sources/crypto.mjs';
import { createFeeds, route } from '../../alerts/feeds.mjs';
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

test('routes symbols to their market', () => {
  assert.deepEqual(route('YAHOO:AAPL'), { market: 'YAHOO', ticker: 'AAPL' });
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
  ledger.staleNotice('YAHOO:AAPL', 123);
  assert.equal(queued[0][0], 'stale:YAHOO:AAPL:123');
  assert.equal(queued[0][1].title, 'No prices for AAPL');
  assert.equal(queued[0][1].url, 'https://w.example/#s=YAHOO%3AAAPL');
});
