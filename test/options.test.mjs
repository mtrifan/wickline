// Tests for the Options panel's data and math (lib/options.mjs) and its formatting helpers
// (public/js/options.js), with small Yahoo-like and Deribit-like fixtures. No internet needed.
import assert from 'node:assert/strict';
import {
  optionsQuery, cryptoBase, pickExpiry, yahooExpiresAt, normalizeYahoo, parseDeribitName, normalizeDeribit,
  normCdf, blackScholes, impliedVol, maxPain, putCallRatio, atmRow, expectedMove, unusualActivity, analyzeChain,
  optionsChain, optionsBody, optionsCacheSize, clearOptionsCache, RISK_FREE,
} from '../lib/options.mjs';
import { optionsUnderlying, daysLeft, timeLeft, expiryKind, expiryLabel, expiryMenu, expiryButton, fmtPrice, fmtCount, fmtIv, oiWindow } from '../public/js/options.js';

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const near = (a, b, eps = 1e-6, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what}${a} ≠ ${b} (±${eps})`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86400;
const NOW = Date.UTC(2026, 10, 20, 15, 0) / 1000; // Fri 20 Nov 2026, 10:00 in New York
const EXP1 = Date.UTC(2026, 10, 27) / 1000; // Yahoo's id for Fri 27 Nov: the date at 00:00 UTC
const EXP2 = Date.UTC(2026, 11, 18) / 1000;
const SPOT = 100;

// A Yahoo contract priced by Black-Scholes at 25% (so tests can check the IV it implies).
function yContract(type, K, exp, { quoted = true, iv = 0.25, volume = 10, oi = 100 } = {}) {
  const T = (yahooExpiresAt(exp) - NOW) / (365 * DAY);
  const p = blackScholes({ type, S: SPOT, K, T, r: RISK_FREE, iv }).price;
  return {
    contractSymbol: `XYZ${new Date(exp * 1000).toISOString().slice(2, 10).replace(/-/g, '')}${type}${String(K * 1000).padStart(8, '0')}`,
    strike: K, currency: 'USD', lastPrice: +p.toFixed(2), change: 0, percentChange: 0, volume, openInterest: oi,
    bid: quoted ? +(p - 0.05).toFixed(2) : 0, ask: quoted ? +(p + 0.05).toFixed(2) : 0, contractSize: 'REGULAR',
    expiration: exp, lastTradeDate: NOW - 60, impliedVolatility: quoted ? iv : 0.00001, inTheMoney: type === 'C' ? K < SPOT : K > SPOT,
  };
}
function yahooFixture(exp, opts = {}) {
  const strikes = [90, 95, 100, 105, 110];
  return {
    optionChain: {
      result: [{
        underlyingSymbol: 'XYZ',
        expirationDates: [EXP1, EXP2],
        strikes,
        quote: { symbol: 'XYZ', shortName: 'XYZ Corp', regularMarketPrice: SPOT, currency: 'USD', regularMarketChangePercent: 1.5, marketState: 'REGULAR' },
        options: [{
          expirationDate: exp,
          // One strike with a call only, to check merging.
          calls: strikes.map((k) => yContract('C', k, exp, opts)).concat([yContract('C', 120, exp, opts)]),
          puts: strikes.map((k) => yContract('P', k, exp, opts)).reverse(), // out of order on purpose
        }],
      }],
      error: null,
    },
  };
}
const yahooNone = { optionChain: { result: [{ underlyingSymbol: 'EURUSD=X', expirationDates: [], strikes: [], quote: { shortName: 'EUR/USD' }, options: [] }], error: null } };

const DERIBIT_FWD = 50100, DERIBIT_INDEX = 50000;
const dItem = (name, extra = {}) => ({
  instrument_name: name, bid_price: 0.02, ask_price: 0.022, mark_price: 0.021, last: 0.0205, volume: 12.5, open_interest: 40,
  mark_iv: 55.5, underlying_price: DERIBIT_FWD, estimated_delivery_price: DERIBIT_INDEX, price_change: -3.2, base_currency: 'BTC', ...extra,
});
const deribitFixture = {
  jsonrpc: '2.0',
  result: [
    dItem('BTC-27NOV26-50000-C'), dItem('BTC-27NOV26-50000-P', { bid_price: 0, ask_price: 0.03 }),
    dItem('BTC-27NOV26-55000-C', { volume: 300, open_interest: 20 }), dItem('BTC-27NOV26-45000-P', { open_interest: 500 }),
    dItem('BTC-25DEC26-60000-C', { underlying_price: 50400 }),
    dItem('BTC-19NOV26-50000-C'), // expired before NOW
    dItem('ETH-27NOV26-2000-C', { base_currency: 'ETH' }), // another coin
    dItem('BTC-PERPETUAL'), // not an option
  ],
};

// A fake fetch: answers by URL, records the calls.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [re, answer] of routes) {
      if (re.test(url)) {
        const a = typeof answer === 'function' ? answer(url, calls) : answer;
        const status = a?.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => a?.body ?? a };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}
// Like server.mjs's getYahooSession: kept until forced to renew.
const session = () => {
  let cur = { cookie: 'A=1', crumb: 'abc' };
  const s = async (force) => { if (force) { s.forced++; cur = { cookie: 'A=2', crumb: 'fresh' }; } return cur; };
  s.forced = 0;
  return s;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

await test('optionsQuery: Yahoo symbols, crypto pairs to Deribit, strict checks', () => {
  assert.deepEqual(optionsQuery('YAHOO:SPY'), { full: 'YAHOO:SPY', source: 'yahoo', ticker: 'SPY', expiry: null });
  assert.equal(optionsQuery('aapl').full, 'YAHOO:AAPL');
  assert.equal(optionsQuery('YAHOO:BRK-B', '1795392000').expiry, 1795392000);
  for (const s of ['BINANCE:BTCUSDT', 'BINANCEF:BTCUSDT', 'COINBASE:BTC-USD', 'YAHOO:BTC-USD', 'BINANCE:BTCFDUSD', 'BINANCEF:BTCUSDT_261225']) {
    const q = optionsQuery(s);
    assert.equal(q.source, 'deribit', s);
    assert.equal(q.currency, 'BTC', s);
  }
  assert.equal(optionsQuery('BINANCEF:ETHUSDT').currency, 'ETH');
  const sol = optionsQuery('BINANCE:SOLUSDT');
  assert.ok(sol.none && /SOL/.test(sol.none) && !sol.source);
  for (const bad of ['', 'YAHOO:SP Y', 'YAHOO:<b>', 'YAHOO:../x', 'YAHOO:A/B', `YAHOO:${'A'.repeat(30)}`, 'YAHOO:', ':SPY', 'YAHOO:SPY"']) {
    assert.equal(optionsQuery(bad).error, 'bad symbol', bad);
  }
  assert.equal(optionsQuery('OANDA:EURUSD').error, 'unknown source');
  for (const bad of ['abc', '-1', '1.5', '1e9', ' 1', '1234567890123']) assert.equal(optionsQuery('YAHOO:SPY', bad).error, 'bad expiry', bad);
  assert.equal(cryptoBase('ETH-USD'), 'ETH');
  assert.equal(cryptoBase('SOLUSDC'), 'SOL');
});

await test('pickExpiry: the one asked for, the next after it, or the nearest not yet expired', () => {
  const ex = [{ t: 100, at: 150 }, { t: 200, at: 250 }, { t: 300, at: 350 }];
  assert.equal(pickExpiry(ex, 200), 200);
  assert.equal(pickExpiry(ex, 210), 300);
  assert.equal(pickExpiry(ex, 999), 300);
  assert.equal(pickExpiry(ex, null, 160 * 1000), 200); // the first one has expired
  assert.equal(pickExpiry(ex, null, 0), 100);
  assert.equal(pickExpiry([], null), null);
  // One asked for that has expired (today's, after 16:00 New York) moves on to the next.
  assert.equal(pickExpiry(ex, 100, 160 * 1000), 200);
  assert.equal(pickExpiry(ex, 210, 160 * 1000), 300);
  const today = { t: EXP1, at: yahooExpiresAt(EXP1) }, next = { t: EXP2, at: yahooExpiresAt(EXP2) };
  assert.equal(pickExpiry([today, next], EXP1, (today.at + 1800) * 1000), EXP2);
  assert.equal(pickExpiry([today, next], EXP1, (today.at - 1800) * 1000), EXP1);
});

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

await test('yahooExpiresAt: 16:00 New York, in winter and in summer', () => {
  assert.equal(yahooExpiresAt(EXP1), EXP1 + 21 * 3600); // EST: 21:00 UTC
  const july = Date.UTC(2026, 6, 17) / 1000;
  assert.equal(yahooExpiresAt(july), july + 20 * 3600); // EDT: 20:00 UTC
});

await test('normalizeYahoo: one row per strike, sorted, calls and puts side by side', () => {
  const c = normalizeYahoo(yahooFixture(EXP1), { symbol: 'YAHOO:XYZ', now: NOW * 1000 });
  assert.equal(c.source, 'yahoo');
  assert.equal(c.delayed, true);
  assert.deepEqual(c.underlying, { symbol: 'XYZ', name: 'XYZ Corp', price: 100, currency: 'USD', change: 1.5, marketState: 'REGULAR' });
  assert.deepEqual(c.expiries.map((e) => e.t), [EXP1, EXP2]);
  assert.equal(c.expiry, EXP1);
  assert.equal(c.expiresAt, EXP1 + 21 * 3600);
  assert.equal(c.multiplier, 100);
  assert.deepEqual(c.rows.map((r) => r.strike), [90, 95, 100, 105, 110, 120]);
  const r100 = c.rows[2];
  assert.ok(r100.call.symbol.includes('C00100000') && r100.put.symbol.includes('P00100000'));
  assert.equal(c.rows[5].put, null); // 120 has a call only
  const closed = normalizeYahoo(yahooFixture(EXP1, { quoted: false }), { symbol: 'YAHOO:XYZ' });
  assert.equal(closed.rows[0].call.bid, null); // Yahoo's 0 = no bid
  assert.equal(closed.rows[0].call.ask, null);
});

await test('normalizeYahoo: no expiries → a friendly "no options"', () => {
  const n = normalizeYahoo(yahooNone, { symbol: 'YAHOO:EURUSD=X' });
  assert.ok(n.none && /EURUSD=X/.test(n.none) && /US-listed stocks/.test(n.none));
  assert.ok(normalizeYahoo({ optionChain: { result: [] } }, { symbol: 'YAHOO:NOPE' }).none);
  assert.ok(normalizeYahoo(null, { symbol: 'YAHOO:NOPE' }).none);
});

await test('parseDeribitName: coin, expiry at 08:00 UTC, strike, call or put', () => {
  assert.deepEqual(parseDeribitName('BTC-27DEC26-100000-C'), { base: 'BTC', at: Date.UTC(2026, 11, 27, 8) / 1000, strike: 100000, type: 'C' });
  assert.equal(parseDeribitName('ETH-5JAN27-2500-P').at, Date.UTC(2027, 0, 5, 8) / 1000);
  assert.equal(parseDeribitName('XRP_USDC-27NOV26-0d55-C'), null); // linear USDC options aren't served
  assert.equal(parseDeribitName('BTC-PERPETUAL'), null);
  assert.equal(parseDeribitName('BTC-27XYZ26-1-C'), null);
});

await test('normalizeDeribit: one expiry, prices in USD (× the underlying), IV from mark_iv', () => {
  const c = normalizeDeribit(deribitFixture, { currency: 'BTC', symbol: 'BINANCE:BTCUSDT', now: NOW * 1000 });
  const nov27 = Date.UTC(2026, 10, 27, 8) / 1000;
  assert.equal(c.source, 'deribit');
  assert.equal(c.delayed, false);
  assert.deepEqual(c.expiries.map((e) => e.t), [nov27, Date.UTC(2026, 11, 25, 8) / 1000]); // the expired 19 Nov is gone
  assert.equal(c.expiry, nov27);
  assert.equal(c.expiresAt, nov27);
  assert.equal(c.underlying.price, DERIBIT_INDEX);
  assert.equal(c.underlying.forward, DERIBIT_FWD);
  assert.deepEqual(c.rows.map((r) => r.strike), [45000, 50000, 55000]);
  const call = c.rows[1].call;
  near(call.bid, 0.02 * DERIBIT_FWD, 1e-6);
  near(call.ask, 0.022 * DERIBIT_FWD, 1e-6);
  near(call.mark, 0.021 * DERIBIT_FWD, 1e-6);
  near(call.ivQuoted, 0.555, 1e-12);
  assert.equal(call.oi, 40);
  assert.equal(c.rows[1].put.bid, null); // no bid
  const dec = normalizeDeribit(deribitFixture, { currency: 'BTC', expiry: Date.UTC(2026, 11, 25, 8) / 1000, now: NOW * 1000 });
  assert.equal(dec.underlying.forward, 50400);
  assert.deepEqual(dec.rows.map((r) => r.strike), [60000]);
  assert.throws(() => normalizeDeribit({ result: [] }, { currency: 'BTC', now: NOW * 1000 }), /no BTC options/);
});

// ---------------------------------------------------------------------------
// Black-Scholes
// ---------------------------------------------------------------------------

await test('normCdf matches the standard normal table', () => {
  near(normCdf(0), 0.5, 1e-15);
  near(normCdf(1.96), 0.9750021048517795, 1e-12);
  near(normCdf(-1), 0.15865525393145707, 1e-12);
  near(normCdf(3), 0.9986501019683699, 1e-12);
  near(normCdf(-8), 6.22096057427178e-16, 1e-20);
  assert.equal(normCdf(50), 1);
});

await test('blackScholes: textbook prices and Greeks (S=K=100, T=1, r=5%, σ=20%)', () => {
  const c = blackScholes({ type: 'C', S: 100, K: 100, T: 1, r: 0.05, iv: 0.2 });
  const p = blackScholes({ type: 'P', S: 100, K: 100, T: 1, r: 0.05, iv: 0.2 });
  near(c.price, 10.450583572185565, 1e-9, 'call ');
  near(p.price, 5.573526022256971, 1e-9, 'put ');
  near(c.delta, 0.6368306511756191, 1e-9, 'call delta ');
  near(p.delta, -0.3631693488243809, 1e-9, 'put delta ');
  near(c.gamma, 0.018762017345846895, 1e-9, 'gamma ');
  near(p.gamma, c.gamma, 1e-15);
  near(c.vega, 0.37524034691693790, 1e-9, 'vega per 1% ');
  near(c.theta * 365, -6.414027546438197, 1e-6, 'call theta/year ');
  near(p.theta * 365, -1.657880423934626, 1e-6, 'put theta/year ');
  near(c.theta, -6.414027546438197 / 365, 1e-9, 'call theta/day ');
  // Hull's example: S=42, K=40, r=10%, σ=20%, 6 months → call 4.76, put 0.81.
  near(blackScholes({ type: 'C', S: 42, K: 40, T: 0.5, r: 0.1, iv: 0.2 }).price, 4.76, 0.005);
  near(blackScholes({ type: 'P', S: 42, K: 40, T: 0.5, r: 0.1, iv: 0.2 }).price, 0.81, 0.005);
  // Put-call parity.
  near(c.price - p.price, 100 - 100 * Math.exp(-0.05), 1e-9);
  assert.equal(blackScholes({ type: 'C', S: 100, K: 100, T: 0, iv: 0.2 }), null);
  assert.equal(blackScholes({ type: 'C', S: 100, K: 100, T: 1, iv: null }), null);
});

await test('impliedVol inverts Black-Scholes, and refuses impossible prices', () => {
  for (const [type, K, iv] of [['C', 90, 0.15], ['C', 110, 0.6], ['P', 95, 0.35], ['P', 120, 1.2]]) {
    const price = blackScholes({ type, S: 100, K, T: 0.25, r: 0.04, iv }).price;
    near(impliedVol({ type, S: 100, K, T: 0.25, r: 0.04, price }), iv, 1e-5, `${type}${K} `);
  }
  assert.equal(impliedVol({ type: 'C', S: 100, K: 80, T: 0.25, r: 0, price: 19 }), null); // below intrinsic
  assert.equal(impliedVol({ type: 'C', S: 100, K: 80, T: 0.25, r: 0, price: 101 }), null); // above the stock
  assert.equal(impliedVol({ type: 'P', S: 100, K: 80, T: 0.25, r: 0, price: 0 }), null);
});

// ---------------------------------------------------------------------------
// Chain statistics
// ---------------------------------------------------------------------------

const leg = (oi, volume = 0, extra = {}) => ({ symbol: 'X', oi, volume, ...extra });

await test('maxPain: the strike where holders get least', () => {
  const rows = [
    { strike: 90, call: leg(100), put: leg(300) },
    { strike: 100, call: leg(200), put: leg(200) },
    { strike: 110, call: leg(300), put: leg(100) },
  ];
  assert.equal(maxPain(rows), 100); // 4000 / 2000 / 4000
  rows[2].put.oi = 500; // puts at 110 pay 12000 at 90, 5000 at 100, 0 at 110 (calls 4000)
  assert.equal(maxPain(rows), 110);
  assert.equal(maxPain([{ strike: 100, call: leg(0), put: null }]), null);
});

await test('putCallRatio by volume and open interest', () => {
  const r = putCallRatio([{ strike: 1, call: leg(100, 50), put: leg(150, 100) }, { strike: 2, call: leg(100, 50), put: null }]);
  assert.equal(r.volume, 1);
  assert.equal(r.oi, 0.75);
  assert.deepEqual([r.callVolume, r.putVolume, r.callOi, r.putOi], [100, 100, 200, 150]);
  assert.equal(putCallRatio([{ strike: 1, call: null, put: leg(5, 5) }]).volume, null);
});

await test('expectedMove: the ATM straddle at mid, and 1σ from the ATM IV', () => {
  const rows = [
    { strike: 95, call: { bid: 6, ask: 6.2, iv: 0.3 }, put: { bid: 1, ask: 1.2, iv: 0.32 } },
    { strike: 100, call: { bid: 3, ask: 3.2, iv: 0.25 }, put: { bid: 0, ask: 0, last: 2.5, iv: 0.27 } },
    { strike: 105, call: { bid: 1, ask: 1.1, iv: 0.24 }, put: null },
  ];
  assert.equal(atmRow(rows, 103).strike, 100); // 105 is nearer but has no put
  const m = expectedMove(rows, 101, 0.25);
  assert.equal(m.strike, 100);
  near(m.straddle, 3.1 + 2.5, 1e-12); // put has no quote: its last trade
  near(m.iv, 0.26, 1e-12);
  near(m.sigma, 101 * 0.26 * 0.5, 1e-12);
});

await test('unusualActivity: volume well above open interest, biggest ratio first', () => {
  const rows = [
    { strike: 90, call: leg(10, 500), put: leg(1000, 500) }, // 50× / not unusual
    { strike: 100, call: leg(100, 250), put: leg(0, 150) }, // 2.5× / brand new (no open interest)
    { strike: 110, call: leg(10, 50), put: null }, // too few contracts
  ];
  const u = unusualActivity(rows, { minVolume: 100 });
  assert.deepEqual(u.map((x) => `${x.strike}${x.type}`), ['100P', '90C', '100C']);
  assert.equal(u[0].ratio, null);
  assert.equal(u[1].ratio, 50);
});

await test('analyzeChain (Yahoo): Greeks, ITM, stats; IV solved from prices when the market is closed', () => {
  const open = analyzeChain(normalizeYahoo(yahooFixture(EXP1), { symbol: 'YAHOO:XYZ' }), { now: NOW * 1000 });
  assert.equal(open.rate, RISK_FREE);
  const r100 = open.rows.find((r) => r.strike === 100);
  assert.equal(r100.call.iv, 0.25);
  assert.ok(r100.call.delta > 0.5 && r100.call.delta < 0.6, `call delta ${r100.call.delta}`);
  assert.ok(r100.put.delta < -0.4 && r100.put.delta > -0.5, `put delta ${r100.put.delta}`);
  assert.ok(r100.call.theta < 0 && r100.call.vega > 0 && r100.call.gamma > 0);
  assert.equal(open.rows[0].call.itm, true); // 90 call
  assert.equal(open.rows[0].put.itm, false);
  assert.ok(!('ivQuoted' in r100.call));
  const st = open.stats;
  assert.equal(st.spot, 100);
  assert.equal(st.atmStrike, 100);
  assert.equal(st.atmIv, 0.25);
  near(st.days, 7 + 6 / 24, 1e-3); // Fri 10:00 to the next Fri 16:00 New York
  near(st.sigmaMove, 100 * 0.25 * Math.sqrt(st.days / 365), 1e-3);
  assert.ok(st.straddle > 0 && Math.abs(st.straddlePct - st.straddle) < 1e-3); // spot 100: $ = %
  near(st.pcVolume, 5 / 6, 1e-3); // 5 puts vs 6 calls, 10 contracts each
  assert.equal(st.maxPain, 100);
  assert.equal(st.quoted, open.rows.flatMap((r) => [r.call, r.put]).filter((c) => c?.mid != null).length); // far out of the money: no bid
  assert.ok(st.quoted >= 6, `${st.quoted} quoted`);
  assert.equal(st.oiMissing, false);

  // Outside market hours: no bids/asks and placeholder IVs (0.00001); IV comes from the last price instead.
  const closed = analyzeChain(normalizeYahoo(yahooFixture(EXP1, { quoted: false, oi: 0 }), { symbol: 'YAHOO:XYZ' }), { now: NOW * 1000 });
  const c100 = closed.rows.find((r) => r.strike === 100).call;
  near(c100.iv, 0.25, 0.01, 'IV from the last price ');
  assert.equal(c100.mid, null);
  assert.equal(closed.stats.quoted, 0);
  assert.equal(closed.stats.oiMissing, true);
  assert.equal(closed.stats.maxPain, null);
  assert.equal(closed.stats.pcOi, null);
  assert.deepEqual(closed.unusual, []); // can't tell without open interest
});

await test('analyzeChain (Deribit): forward price, no interest rate, mark IV', () => {
  const a = analyzeChain(normalizeDeribit(deribitFixture, { currency: 'BTC', now: NOW * 1000 }), { now: NOW * 1000 });
  assert.equal(a.rate, 0);
  assert.equal(a.stats.spot, DERIBIT_FWD);
  const c = a.rows.find((r) => r.strike === 50000).call;
  assert.equal(c.iv, 0.555);
  assert.equal(c.itm, true); // 50,000 < forward 50,100
  const T = (Date.UTC(2026, 10, 27, 8) / 1000 - NOW) / (365 * DAY);
  near(c.delta, blackScholes({ type: 'C', S: DERIBIT_FWD, K: 50000, T, r: 0, iv: 0.555 }).delta, 1e-4);
  assert.equal(a.stats.maxPain, 50000);
  assert.deepEqual(a.unusual.map((x) => x.symbol), ['BTC-27NOV26-55000-C']); // 300 traded vs 20 open
});

// ---------------------------------------------------------------------------
// Fetching (fake fetch)
// ---------------------------------------------------------------------------

await test('optionsChain (Yahoo): crumb and cookie, the expiry asked for, cached a minute', async () => {
  clearOptionsCache();
  const f = fakeFetch([
    [/options\/XYZ\?.*date=/, (url) => yahooFixture(Number(/date=(\d+)/.exec(url)[1]))],
    [/options\/XYZ\?/, yahooFixture(EXP1)],
  ]);
  const deps = { fetchImpl: f, getYahooSession: session(), now: NOW * 1000 };
  const a = await optionsChain(optionsQuery('YAHOO:XYZ'), deps);
  assert.equal(a.expiry, EXP1);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /^https:\/\/query1\.finance\.yahoo\.com\/v7\/finance\/options\/XYZ\?crumb=abc$/);
  assert.ok(a.updated > 0 && a.stats && Array.isArray(a.unusual));
  const b = await optionsChain(optionsQuery('YAHOO:XYZ', String(EXP2)), deps);
  assert.equal(b.expiry, EXP2);
  assert.match(f.calls[1], /date=/);
  assert.equal(f.calls.length, 2);
  await optionsChain(optionsQuery('YAHOO:XYZ', String(EXP2)), deps); // cached
  await optionsChain(optionsQuery('YAHOO:XYZ'), deps);
  assert.equal(f.calls.length, 2);
});

await test('optionsChain (Yahoo): a new session on 401, "no options" for symbols without them', async () => {
  clearOptionsCache();
  let n = 0;
  const f = fakeFetch([
    [/options\/XYZ/, () => (++n === 1 ? { status: 401, body: {} } : yahooFixture(EXP1))],
    [/options\/EURUSD/, yahooNone],
    [/options\/BAD/, { status: 500, body: {} }],
  ]);
  const sess = session();
  const deps = { fetchImpl: f, getYahooSession: sess, now: NOW * 1000 };
  const a = await optionsChain(optionsQuery('YAHOO:XYZ'), deps);
  assert.equal(sess.forced, 1);
  assert.match(f.calls[1], /crumb=fresh/);
  assert.equal(a.rows.length, 6);
  const none = await optionsChain(optionsQuery('YAHOO:EURUSD=X'), deps);
  assert.ok(none.none && none.symbol === 'YAHOO:EURUSD=X' && !none.rows);
  await assert.rejects(optionsChain(optionsQuery('YAHOO:BAD'), deps), (e) => e.status === 502 && /Yahoo/.test(e.message));
  const sol = await optionsChain(optionsQuery('BINANCE:SOLUSDT'), deps);
  assert.ok(/Bitcoin and Ether only/.test(sol.none));
  await assert.rejects(optionsChain(optionsQuery('YAHOO:A B'), deps), (e) => e.status === 400);
});

await test('optionsChain (Deribit): one book for every expiry, no key', async () => {
  clearOptionsCache();
  const f = fakeFetch([[/deribit\.com\/api\/v2\/public\/get_book_summary_by_currency\?currency=BTC&kind=option$/, deribitFixture]]);
  const deps = { fetchImpl: f, now: NOW * 1000 };
  const a = await optionsChain(optionsQuery('COINBASE:BTC-USD'), deps);
  assert.equal(a.source, 'deribit');
  assert.equal(a.symbol, 'COINBASE:BTC-USD');
  assert.equal(a.rows.length, 3);
  const b = await optionsChain(optionsQuery('BINANCE:BTCUSDT', String(a.expiries[1].t)), deps);
  assert.equal(b.expiry, a.expiries[1].t);
  assert.equal(f.calls.length, 1); // the same cached book
});

await test('optionsChain (Yahoo): an expiry asked for is one request; dates no longer listed move to the next', async () => {
  clearOptionsCache();
  const OLD = EXP1 - 7 * DAY, GONE = EXP1 - 14 * DAY;
  const f = fakeFetch([
    [new RegExp(`options/XYZ\\?.*date=${GONE}`), { status: 404, body: {} }], // a date Yahoo has forgotten
    [/options\/XYZ\?.*date=/, (url) => yahooFixture(Number(/date=(\d+)/.exec(url)[1]))],
    [/options\/XYZ\?/, yahooFixture(EXP1)],
  ]);
  const deps = { fetchImpl: f, getYahooSession: session(), now: NOW * 1000 };
  const a = await optionsChain(optionsQuery('YAHOO:XYZ', String(EXP2)), deps);
  assert.equal(a.expiry, EXP2);
  assert.equal(f.calls.length, 1); // its own page only: it lists the expiries and has the quote
  assert.match(f.calls[0], new RegExp(`date=${EXP2}$`));
  assert.deepEqual(a.expiries.map((e) => e.t), [EXP1, EXP2]);
  assert.equal(a.underlying.price, SPOT);
  // Last week's expiry (still answered, but not listed): the next listed one's page.
  const b = await optionsChain(optionsQuery('YAHOO:XYZ', String(OLD)), deps);
  assert.equal(b.expiry, EXP1);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[2], new RegExp(`date=${EXP1}$`));
  assert.equal(b.rows.length, 6);
  // A date Yahoo answers 404 for: its default page (EXP1's here) decides.
  const c = await optionsChain(optionsQuery('YAHOO:XYZ', String(GONE)), deps);
  assert.equal(c.expiry, EXP1);
  assert.equal(f.calls.length, 5);
  assert.match(f.calls[4], /XYZ\?crumb=abc$/);
});

await test('optionsBody: gzipped once per fetched chain; the caches stay small', async () => {
  clearOptionsCache();
  const { gunzipSync } = await import('node:zlib');
  const f = fakeFetch([
    [/options\/EURUSD/, yahooNone],
    [/options\/[A-Z]+\?/, yahooFixture(EXP1)],
    [/deribit\.com/, deribitFixture],
  ]);
  const deps = { fetchImpl: f, getYahooSession: session(), now: NOW * 1000 };
  const body = await optionsBody(optionsQuery('YAHOO:XYZ'), deps);
  assert.equal(await optionsBody(optionsQuery('YAHOO:XYZ'), deps), body); // the same buffer while cached
  assert.deepEqual(JSON.parse(gunzipSync(body)), await optionsChain(optionsQuery('YAHOO:XYZ'), deps));
  assert.equal(f.calls.length, 1);
  const btc = await optionsBody(optionsQuery('COINBASE:BTC-USD'), deps);
  const btc2 = await optionsBody(optionsQuery('BINANCE:BTCUSDT'), deps); // the same book, another symbol
  assert.notEqual(btc2, btc);
  assert.equal(JSON.parse(gunzipSync(btc2)).symbol, 'BINANCE:BTCUSDT');
  assert.ok(JSON.parse(gunzipSync(await optionsBody(optionsQuery('YAHOO:EURUSD=X'), deps))).none);
  for (let i = 0; i < 80; i++) await optionsBody(optionsQuery(`YAHOO:T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`), deps);
  const size = optionsCacheSize();
  assert.ok(size.chains <= 50 && size.bodies <= 50, JSON.stringify(size));
});

// ---------------------------------------------------------------------------
// The panel's helpers (public/js/options.js)
// ---------------------------------------------------------------------------

await test('optionsUnderlying: a contract chart keeps its underlying\'s options', () => {
  assert.equal(optionsUnderlying('YAHOO:SPY261204C00690000'), 'YAHOO:SPY');
  assert.equal(optionsUnderlying('YAHOO:BRK.B270115P00450000'), 'YAHOO:BRK.B');
  assert.equal(optionsUnderlying('YAHOO:AAPL'), 'YAHOO:AAPL');
  assert.equal(optionsUnderlying('BINANCE:BTCUSDT'), 'BINANCE:BTCUSDT');
  assert.equal(optionsUnderlying(undefined), '');
  // Roots that aren't the underlying's ticker: index weeklies, share classes.
  assert.equal(optionsUnderlying('YAHOO:SPXW261204C06900000'), 'YAHOO:^SPX');
  assert.equal(optionsUnderlying('YAHOO:NDXP261204P21000000'), 'YAHOO:^NDX');
  assert.equal(optionsUnderlying('YAHOO:VIX261216C00020000'), 'YAHOO:^VIX');
  assert.equal(optionsUnderlying('YAHOO:BRKB261218C00500000'), 'YAHOO:BRK-B');
  assert.equal(optionsUnderlying('YAHOO:BFB261218P00030000'), 'YAHOO:BF-B');
});

await test('analyzeChain (Yahoo): a last trade is solved with the time to expiry it had then', () => {
  // Expiry day, 15:55 New York; the contract last traded at 10:00 at a 41% IV.
  const exp = Date.UTC(2026, 10, 20) / 1000, at = yahooExpiresAt(exp);
  const traded = at - 6 * 3600, now = (at - 300) * 1000;
  const T = (at - traded) / (365 * DAY);
  const last = +blackScholes({ type: 'C', S: SPOT, K: 101, T, r: RISK_FREE, iv: 0.41 }).price.toFixed(4);
  const c = { symbol: 'XYZ261120C00101000', last, bid: null, ask: null, change: 0, volume: 5, oi: 10, ivQuoted: 0.00001, traded };
  const chain = { source: 'yahoo', symbol: 'YAHOO:XYZ', underlying: { symbol: 'XYZ', price: SPOT }, expiries: [{ t: exp, at }], expiry: exp, expiresAt: at, rows: [{ strike: 101, call: c, put: null }] };
  near(analyzeChain(chain, { now }).rows[0].call.iv, 0.41, 2e-3, 'IV ');
  // No trade time: the time left now, as before.
  const noTime = analyzeChain({ ...chain, rows: [{ strike: 101, call: { ...c, traded: null }, put: null }] }, { now }).rows[0].call.iv;
  assert.ok(noTime > 1, String(noTime));
});

await test('panel formatting: days left, prices, counts, IV', () => {
  const now = Date.UTC(2026, 10, 23, 9) * 1;
  const at = Date.UTC(2026, 10, 23, 21) / 1000;
  assert.equal(daysLeft(at, now), 0);
  assert.equal(timeLeft(at, now), '12h');
  assert.equal(timeLeft(at + 11 * DAY, now), '11d');
  assert.equal(timeLeft(at, now + 13 * 3600e3), 'expired');
  assert.equal(fmtPrice(1.5), '1.50');
  assert.equal(fmtPrice(23397.12), '23,397');
  assert.equal(fmtPrice(1849.67), '1,849.67');
  assert.equal(fmtPrice(1849.67, true), '1,850');
  assert.equal(fmtPrice(null), '—');
  assert.equal(fmtCount(12345), '12,345');
  assert.equal(fmtCount(104.7), '104.7');
  assert.equal(fmtIv(0.2531), '25.3%');
});

await test('oiWindow: strikes around the price, max pain included, no empty ends', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ strike: 50 + i, call: leg(i >= 20 && i <= 180 ? 1 : 0), put: leg(0) }));
  const [lo, hi] = oiWindow(rows, 150, null, 60);
  assert.equal(hi - lo, 60);
  assert.ok(rows[lo].strike <= 150 && rows[hi - 1].strike >= 150);
  const [lo2] = oiWindow(rows, 150, 110, 60); // max pain 40 strikes below
  assert.equal(rows[lo2].strike, 110);
  const [lo3, hi3] = oiWindow(rows, 60, null, 60); // near the bottom: starts where open interest does
  assert.equal(rows[lo3].strike, 70);
  assert.equal(hi3, 60);
  assert.deepEqual(oiWindow([], 100), [0, 0]);
});

await test('expiries are marked monthly, weekly or daily', () => {
  const e = (y, m, d) => ({ t: Date.UTC(y, m - 1, d) / 1000, at: Date.UTC(y, m - 1, d, 21) / 1000 });
  // December 2026: Fridays 4, 11, 18 (third), 25 (Christmas, so that week's expiry is Thursday the 24th).
  // Stocks only have monthlies and weeklies: a Wednesday or a Thursday expiry is a weekly too.
  const list = [e(2026, 12, 2), e(2026, 12, 4), e(2026, 12, 11), e(2026, 12, 17), e(2026, 12, 18), e(2026, 12, 24)];
  assert.deepEqual(list.map((x) => expiryKind(x, list)), ['weekly', 'weekly', 'weekly', 'weekly', 'monthly', 'weekly']);
  // The third Friday is a holiday (Juneteenth, June 19 2026): the monthly is Thursday the 18th.
  const june = [e(2026, 6, 12), e(2026, 6, 18), e(2026, 6, 26)];
  assert.deepEqual(june.map((x) => expiryKind(x, june)), ['weekly', 'monthly', 'weekly']);
  // Deribit: the last Friday of the month is the monthly.
  const btc = [e(2026, 12, 18), e(2026, 12, 25), e(2026, 12, 26)];
  assert.deepEqual(btc.map((x) => expiryKind(x, btc, 'deribit')), ['weekly', 'monthly', 'daily']);
  assert.equal(expiryLabel(e(2026, 12, 18), Date.UTC(2026, 11, 7), 'monthly'), 'Fri, Dec 18 · 11d · Monthly');
  assert.equal(expiryLabel(e(2026, 12, 18), Date.UTC(2026, 11, 7)), 'Fri, Dec 18 · 11d');
  // The menu: a month heading before each month's rows (with the year in another year), the picked one marked.
  const d = { source: 'yahoo', expiry: e(2026, 12, 18).t, expiries: [e(2026, 11, 27), e(2026, 12, 4), e(2026, 12, 18), e(2027, 1, 15)] };
  const html = expiryMenu(d, Date.UTC(2026, 10, 24));
  assert.deepEqual([...html.matchAll(/class="menu-title">([^<]+)</g)].map((m) => m[1]), ['November', 'December', 'January 2027']);
  assert.deepEqual([...html.matchAll(/class="op-exp-row op-(\w+)( on)?"/g)].map((m) => m[1] + (m[2] ? '*' : '')), ['weekly', 'weekly', 'monthly*', 'monthly']);
  assert.ok(html.includes('<span>Fri 18</span><i class="op-kind op-monthly">M</i><small>24d</small>'), html);
  assert.match(html, /title="Fri, Dec 18 · 24d · Monthly"/);
  // The key at the bottom names the kinds in the list: no "Daily" for stocks, but there is one on Deribit.
  const keyOf = (h) => [...h.matchAll(/<span><i class="op-kind op-\w+">(\w)<\/i>(\w+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(keyOf(html), ['M Monthly', 'W Weekly']);
  assert.deepEqual(keyOf(expiryMenu({ source: 'deribit', expiry: btc[0].t, expiries: btc }, Date.UTC(2026, 10, 24))), ['M Monthly', 'W Weekly', 'D Daily']);
  // The button: the picked expiry and its badge.
  assert.equal(expiryButton(d, Date.UTC(2026, 10, 24)), '<span>Fri, Dec 18 · 24d</span><i class="op-kind op-monthly" title="Monthly">M</i>');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
