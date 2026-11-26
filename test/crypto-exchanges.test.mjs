// Bybit and OKX (public/js/crypto-exchanges.js) against canned exchange answers, no network.
// Run: node test/crypto-exchanges.test.mjs
import assert from 'node:assert/strict';
import { ExchangeFeed, exchangeMarket, streamExchangeQuotes } from '../public/js/crypto-exchanges.js';
import { tfById } from '../public/js/timeframes.js';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack}`); }
};

// fetch: the first route whose test matches the URL answers; every URL asked is kept.
let routes = [];
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(url);
  const r = routes.find(([re]) => re.test(url));
  if (!r) return { ok: false, status: 404, json: async () => ({}) };
  const body = typeof r[1] === 'function' ? r[1](url) : r[1];
  return { ok: true, status: 200, json: async () => body };
};
const H = 3600 * 1000;
const T0 = Date.UTC(2026, 10, 20); // a midnight, UTC
// Bybit and OKX both list candles newest first, prices as strings.
const kline = (i, extra = []) => [String(T0 + i * H), '100', '110', '90', String(100 + i), '5', ...extra];

await test('Bybit: candles come oldest first, older pages ask for an end before the oldest, a short page ends the history', async () => {
  asked.length = 0;
  routes = [
    [/instruments-info.*symbol=BTCUSDT/, { retCode: 0, result: { list: [{ baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.10' } }] } }],
    [/kline/, (url) => {
      const end = /end=(\d+)/.exec(url)?.[1];
      // Now: 1000 hourly candles (indexes 1000..1999); before that: 10 more (990..999), then nothing.
      const from = end ? 990 : 1000, to = end ? 999 : 1999;
      const list = [];
      for (let i = to; i >= from; i--) list.push(kline(i));
      return { retCode: 0, result: { list } };
    }],
  ];
  const f = new ExchangeFeed('BYBIT', 'btcusdt', tfById('1h'));
  f.shift = 0;
  const r = await f.loadInitial();
  assert.equal(r.meta.name, 'BTC / USDT');
  assert.equal(r.meta.precision, 1);
  assert.equal(r.bars.length, 1000);
  assert.equal(r.bars[0].time, (T0 + 1000 * H) / 1000);
  assert.ok(r.bars.every((b, i) => i === 0 || b.time > r.bars[i - 1].time), 'oldest first');
  assert.equal(r.bars[0].close, 1100);
  const older = await f.loadOlder(r.bars[0].time);
  assert.equal(older.length, 10);
  assert.match(asked.at(-1), new RegExp(`end=${T0 + 1000 * H - 1}`));
  assert.equal(f.canLoadMore, false, 'a page of 10 is the start of the history');
  assert.deepEqual(await f.loadOlder(older[0].time), []);
});

await test('Bybit perpetuals: names say perpetual, the category is linear', async () => {
  asked.length = 0;
  routes = [
    [/instruments-info/, { retCode: 0, result: { list: [{ baseCoin: 'ETH', quoteCoin: 'USDT', priceFilter: { tickSize: '0.01' } }] } }],
    [/kline/, { retCode: 0, result: { list: [kline(1), kline(0)] } }],
  ];
  const r = await new ExchangeFeed('BYBITF', 'ETHUSDT', tfById('1h')).loadInitial();
  assert.equal(r.meta.name, 'ETH / USDT perpetual');
  assert.ok(asked.every((u) => u.includes('category=linear')));
});

await test('Bybit: an unknown symbol is an error the chart can show', async () => {
  routes = [[/instruments-info/, { retCode: 0, result: { list: [] } }], [/kline/, { retCode: 10001, retMsg: 'Not supported symbols' }]];
  await assert.rejects(new ExchangeFeed('BYBIT', 'NOPEUSDT', tfById('1h')).loadInitial(), /NOPEUSDT|Not supported/);
});

await test('OKX: past the recent window it switches to history-candles; perpetual volume is in coins, not contracts', async () => {
  asked.length = 0;
  routes = [
    [/public\/instruments/, { code: '0', data: [{ ctValCcy: 'BTC', settleCcy: 'USDT', tickSz: '0.1', ctVal: '0.01' }] }],
    [/history-candles/, (url) => {
      const after = Number(/after=(\d+)/.exec(url)[1]);
      return { code: '0', data: after >= T0 ? [kline(-1, ['7', '0', '0', '1']), kline(-2, ['8', '0', '0', '1'])] : [] };
    }],
    [/market\/candles/, (url) => (/after=/.test(url) ? { code: '0', data: [] } : { code: '0', data: [kline(1, ['3', '0', '0', '0']), kline(0, ['2', '0', '0', '1'])] })],
  ];
  const f = new ExchangeFeed('OKXF', 'BTC-USDT', tfById('1h'));
  f.shift = 0;
  const r = await f.loadInitial();
  assert.equal(r.meta.name, 'BTC / USDT perpetual');
  assert.equal(f.size, 0.01, 'coins per contract, for live trade volume');
  assert.deepEqual(r.bars.map((b) => b.volume), [8, 7, 2, 3], 'the coin column (and older bars from history-candles)');
  assert.ok(asked.some((u) => u.includes('instId=BTC-USDT-SWAP')), 'OKX id ends in -SWAP');
  assert.ok(asked.some((u) => u.includes('bar=1H')));
  assert.ok(asked.some((u) => u.includes(`after=${T0}`)), 'history before the oldest bar');
  assert.equal(f.canLoadMore, false, 'a short history page is the start');
});

await test('OKX: daily bars use the UTC day, not Hong Kong time', async () => {
  asked.length = 0;
  routes = [[/public\/instruments/, { code: '0', data: [{ baseCcy: 'ETH', quoteCcy: 'USDT', tickSz: '0.01' }] }], [/candles/, { code: '0', data: [] }]];
  await new ExchangeFeed('OKX', 'ETH-USDT', tfById('1D')).loadInitial();
  assert.ok(asked.some((u) => u.includes('bar=1Dutc')));
});

await test('markets: perpetual lists keep USDT/USDC perpetuals only, with 24h change and turnover', async () => {
  routes = [
    [/market\/tickers\?instType=SWAP/, { code: '0', data: [
      { instId: 'BTC-USDT-SWAP', last: '110', open24h: '100', volCcy24h: '2' },
      { instId: 'BTC-USD-SWAP', last: '110', open24h: '100', volCcy24h: '2' }, // coin-margined
      { instId: 'BTC-USDT-261225', last: '110', open24h: '100', volCcy24h: '2' }, // dated future
    ] }],
    [/instruments-info\?category=linear/, { retCode: 0, result: { list: [
      { symbol: 'BTCUSDT', status: 'Trading', contractType: 'LinearPerpetual', baseCoin: 'BTC', quoteCoin: 'USDT' },
      { symbol: 'BTCUSDT-26DEC26', status: 'Trading', contractType: 'LinearFutures', baseCoin: 'BTC', quoteCoin: 'USDT' },
    ] } }],
    [/tickers\?category=linear/, { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '99', prevPrice24h: '100', turnover24h: '5000' }] } }],
  ];
  const okx = await exchangeMarket('OKXF');
  assert.deepEqual(okx, [{ ticker: 'BTC-USDT', base: 'BTC', quote: 'USDT', price: 110, change: 10, rank: 220 }]);
  const bybit = await exchangeMarket('BYBITF');
  assert.deepEqual(bybit.map((r) => [r.ticker, r.price, Math.round(r.change), r.rank]), [['BTCUSDT', 99, -1, 5000]]);
});

await test('live quotes: a Bybit perpetual update without the 24h open keeps the one it had', async () => {
  const sockets = [];
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(m) { this.sent.push(m); }
    close() {}
  };
  routes = [
    [/instruments-info\?category=linear/, { retCode: 0, result: { list: [] } }],
    [/tickers\?category=linear/, { retCode: 0, result: { list: [] } }],
  ];
  const got = [];
  const stream = { gen: 1, sockets: [], timers: [], emit: (full, price, open) => got.push([full, price, open]) };
  streamExchangeQuotes(stream, 'BYBITF', ['SOLUSDT'], 1);
  await new Promise((r) => setTimeout(r, 10));
  const ws = sockets[0];
  assert.match(ws.url, /\/v5\/public\/linear$/);
  assert.deepEqual(JSON.parse(ws.sent[0]), { op: 'subscribe', args: ['tickers.SOLUSDT'] });
  ws.onmessage({ data: JSON.stringify({ topic: 'tickers.SOLUSDT', type: 'snapshot', data: { symbol: 'SOLUSDT', lastPrice: '70', prevPrice24h: '50' } }) });
  ws.onmessage({ data: JSON.stringify({ topic: 'tickers.SOLUSDT', type: 'delta', data: { symbol: 'SOLUSDT', lastPrice: '75' } }) });
  ws.onmessage({ data: 'pong' }); // not JSON: ignored
  assert.deepEqual(got, [['BYBITF:SOLUSDT', 70, 50], ['BYBITF:SOLUSDT', 75, 50]]);
  // The list stops (a new generation): closing the socket ends its keep-alive and doesn't reconnect.
  stream.gen = 2;
  ws.onclose();
  assert.equal(stream.timers.length, 0, 'no reconnect after the list stopped');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
