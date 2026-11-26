// Option chains for the Options panel, from two free sources in one shape:
//  - Yahoo: US-listed stocks and ETFs, ~15 minutes delayed (needs the session cookie and crumb).
//  - Deribit: BTC and ETH options, real time, no key. Its prices are in the coin; they're
//    converted to USD here (× the expiry's underlying price).
// Pure parts first (input checks, normalizers, Black-Scholes, chain statistics; unit-tested in
// test/options.test.mjs), then the fetching and caching behind server.mjs's /api/options.

import { gzipSync } from 'node:zlib';

// Risk-free rate for the Black-Scholes Greeks of stock options (no dividends). Deribit's are
// priced on the expiry's forward price, so they use 0, like Deribit itself.
export const RISK_FREE = 0.04;
export const YAHOO_TTL = 60 * 1000; // Yahoo is delayed anyway: once a minute per (symbol, expiry)
export const DERIBIT_TTL = 15 * 1000; // real time: a fresh book every 15 seconds
// Unusual activity: volume at least this many times the open interest, and at least this many
// contracts (Deribit's are one coin each).
export const UNUSUAL_RATIO = 2;
const UNUSUAL_MIN = { yahoo: 100, BTC: 5, ETH: 50 };

const DAY = 86400;
const YEAR = 365 * DAY;
const MIN_T = 1 / (365 * 24); // an hour: Greeks of a contract about to expire stay finite
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => (num(v) > 0 ? Number(v) : null);
const count = (v) => (num(v) > 0 ? Number(v) : 0);
/** v to n significant digits (smaller JSON), null when it isn't a number. */
const sig = (v, n = 5) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(n)));

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const SYMBOL_RE = /^(?:([A-Z]{2,10}):)?(\^?[A-Z0-9][A-Z0-9._=-]{0,23})$/;
const CRYPTO_SOURCES = new Set(['BINANCE', 'BINANCEF', 'COINBASE', 'BYBIT', 'BYBITF', 'OKX', 'OKXF']);
export const DERIBIT_COINS = { BTC: 'Bitcoin', ETH: 'Ether' };

/** A crypto pair's coin: "BTCUSDT" → "BTC", "ETH-USD" → "ETH", "BTCUSDT_261225" → "BTC". */
export function cryptoBase(pair) {
  return String(pair).replace(/_\d+$/, '').replace(/[-/_]?(FDUSD|USDT|USDC|BUSD|TUSD|USDP|DAI|USD|EUR|GBP|TRY|BRL|JPY)$/, '') || pair;
}

const noneFor = (what) => `${what} has no listed options here. Options cover US-listed stocks and ETFs (Yahoo) and Bitcoin and Ether (Deribit).`;

/**
 * Checks /api/options?symbol=&expiry= and says where its options come from:
 * { error } | { full, source: 'yahoo', ticker, expiry } | { full, source: 'deribit', currency, expiry }
 * | { full, none: message } (a symbol that can't have options).
 */
export function optionsQuery(symbol, expiry) {
  const m = SYMBOL_RE.exec(String(symbol ?? '').trim().toUpperCase());
  if (!m) return { error: 'bad symbol' };
  let exp = null;
  if (expiry != null && expiry !== '') {
    if (!/^\d{1,12}$/.test(String(expiry))) return { error: 'bad expiry' };
    exp = Number(expiry);
  }
  const src = m[1] || 'YAHOO';
  const ticker = m[2];
  const full = `${src}:${ticker}`;
  if (src === 'YAHOO') {
    const coin = /^(BTC|ETH)-USD$/.exec(ticker);
    if (coin) return { full, source: 'deribit', currency: coin[1], expiry: exp };
    return { full, source: 'yahoo', ticker, expiry: exp };
  }
  if (!CRYPTO_SOURCES.has(src)) return { error: 'unknown source' };
  const base = cryptoBase(ticker);
  if (DERIBIT_COINS[base]) return { full, source: 'deribit', currency: base, expiry: exp };
  return { full, none: `Deribit lists options on Bitcoin and Ether only, so ${base} has none here.` };
}

/**
 * The expiry to show: the one asked for, else the next one after it, else the nearest that hasn't
 * expired. One asked for that has expired (today's, after the close) moves on to the next that hasn't.
 */
export function pickExpiry(expiries, want, now = Date.now()) {
  if (!expiries.length) return null;
  if (want != null) {
    const from = expiries.findIndex((e) => e.t >= want);
    const live = from < 0 ? null : expiries.slice(from).find((e) => e.at * 1000 > now);
    if (live) return live.t;
    if (expiries.some((e) => e.t === want)) return want;
    return (expiries[from] || expiries.at(-1)).t;
  }
  return (expiries.find((e) => e.at * 1000 > now) || expiries[0]).t;
}

// ---------------------------------------------------------------------------
// Normalizers: { source, symbol, delayed, underlying: { symbol, name, price, forward?, currency,
// change? }, expiries: [{ t, at }], expiry, expiresAt, multiplier, rows: [{ strike, call, put }] }.
// t is the source's id for an expiry (Yahoo: the date at 00:00 UTC), at the moment it expires.
// ---------------------------------------------------------------------------

let nyHour = null; // built once: a DateTimeFormat costs far more than a format()
/** Yahoo's expiry date (00:00 UTC) → the moment US options stop trading: 16:00 in New York. */
export function yahooExpiresAt(t) {
  const est = t + 21 * 3600; // 16:00 New York in winter
  try {
    nyHour ??= new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
    const hour = Number(nyHour.format(est * 1000));
    return est - (hour - 16) * 3600; // summer time: 20:00 UTC
  } catch {
    return est;
  }
}

const yahooContract = (o) => ({
  symbol: String(o.contractSymbol || ''),
  last: pos(o.lastPrice),
  bid: pos(o.bid),
  ask: pos(o.ask),
  change: num(o.change),
  volume: count(o.volume),
  oi: count(o.openInterest),
  ivQuoted: num(o.impliedVolatility),
  traded: num(o.lastTradeDate),
});

/** Yahoo's /v7/finance/options answer → a chain, or { none } when the symbol has no options. */
export function normalizeYahoo(json, { symbol = '', now = Date.now() } = {}) {
  const res = json?.optionChain?.result?.[0];
  const ticker = symbol.replace(/^YAHOO:/, '');
  if (!res || !Array.isArray(res.expirationDates) || !res.expirationDates.length) {
    return { symbol, none: noneFor(res?.quote?.shortName ? `${ticker} (${res.quote.shortName})` : ticker) };
  }
  const q = res.quote || {};
  const page = res.options?.[0] || {};
  const expiries = res.expirationDates.filter((t) => Number.isFinite(t)).sort((a, b) => a - b).map((t) => ({ t, at: yahooExpiresAt(t) }));
  const expiry = Number.isFinite(page.expirationDate) ? page.expirationDate : pickExpiry(expiries, null, now);
  const by = new Map();
  const add = (list, side) => {
    for (const o of list || []) {
      const k = num(o?.strike);
      if (!(k > 0) || !o.contractSymbol) continue;
      if (!by.has(k)) by.set(k, { strike: k, call: null, put: null });
      by.get(k)[side] = yahooContract(o);
    }
  };
  add(page.calls, 'call');
  add(page.puts, 'put');
  return {
    source: 'yahoo',
    symbol,
    delayed: true,
    underlying: {
      symbol: res.underlyingSymbol || q.symbol || ticker,
      name: q.longName || q.shortName || ticker,
      price: num(q.regularMarketPrice),
      currency: q.currency || 'USD',
      change: num(q.regularMarketChangePercent),
      marketState: q.marketState || null,
    },
    expiries,
    expiry,
    expiresAt: yahooExpiresAt(expiry),
    multiplier: 100,
    unit: 'shares',
    rows: [...by.values()].sort((a, b) => a.strike - b.strike),
  };
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** "BTC-27DEC26-100000-C" → { base: 'BTC', at (08:00 UTC that day, when Deribit options expire), strike, type }. */
export function parseDeribitName(name) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name || '');
  if (!m || !(m[3] in MONTHS)) return null;
  const at = Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8) / 1000;
  return { base: m[1], at, strike: Number(m[5].replace('d', '.')), type: m[6] };
}

/** Deribit's get_book_summary_by_currency (kind=option) → the chain of one expiry. */
export function normalizeDeribit(json, { currency = 'BTC', symbol = '', expiry = null, now = Date.now() } = {}) {
  const byExp = new Map(); // at -> [{ p, x }]
  let index = null;
  for (const x of Array.isArray(json?.result) ? json.result : []) {
    const p = parseDeribitName(x?.instrument_name);
    if (!p || p.base !== currency || p.at * 1000 <= now) continue;
    if (!byExp.has(p.at)) byExp.set(p.at, []);
    byExp.get(p.at).push({ p, x });
    if (index == null && pos(x.estimated_delivery_price)) index = Number(x.estimated_delivery_price);
  }
  if (!byExp.size) throw Object.assign(new Error(`Deribit returned no ${currency} options`), { status: 502 });
  const expiries = [...byExp.keys()].sort((a, b) => a - b).map((t) => ({ t, at: t }));
  const sel = pickExpiry(expiries, expiry, now);
  const items = byExp.get(sel);
  const fwds = items.map(({ x }) => pos(x.underlying_price)).filter(Boolean).sort((a, b) => a - b);
  const forward = fwds.length ? fwds[fwds.length >> 1] : index;
  const by = new Map();
  for (const { p, x } of items) {
    const u = pos(x.underlying_price) || forward;
    const usd = (v) => (pos(v) && u ? sig(Number(v) * u, 6) : null);
    if (!by.has(p.strike)) by.set(p.strike, { strike: p.strike, call: null, put: null });
    by.get(p.strike)[p.type === 'C' ? 'call' : 'put'] = {
      symbol: x.instrument_name,
      last: usd(x.last),
      bid: usd(x.bid_price),
      ask: usd(x.ask_price),
      mark: usd(x.mark_price),
      change: num(x.price_change), // percent, today
      volume: count(x.volume),
      oi: count(x.open_interest),
      ivQuoted: pos(x.mark_iv) ? Number(x.mark_iv) / 100 : null,
    };
  }
  return {
    source: 'deribit',
    symbol,
    delayed: false,
    underlying: { symbol: currency, name: DERIBIT_COINS[currency] || currency, price: index ?? forward, forward, currency: 'USD' },
    expiries,
    expiry: sel,
    expiresAt: sel,
    multiplier: 1,
    unit: currency,
    rows: [...by.values()].sort((a, b) => a.strike - b.strike),
  };
}

// ---------------------------------------------------------------------------
// Black-Scholes
// ---------------------------------------------------------------------------

/** Standard normal cumulative distribution (West's double-precision version of Hart's algorithm). */
export function normCdf(x) {
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165; n = n * z + 33.912866078383; n = n * z + 112.079291497871;
      n = n * z + 221.213596169931; n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674;
      d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b; b = z + 3 / b; b = z + 2 / b; b = z + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

const normPdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

/**
 * Black-Scholes price and Greeks of a European call ('C') or put ('P'): S underlying, K strike,
 * T years, r risk-free rate, iv volatility (0.25 = 25%). theta: per calendar day; vega: per 1
 * point of volatility. Null when an input is missing.
 */
export function blackScholes({ type, S, K, T, r = 0, iv }) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return null;
  const sq = Math.sqrt(T), v = iv * sq;
  const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / v, d2 = d1 - v;
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const call = type === 'C';
  const price = call ? S * normCdf(d1) - K * disc * normCdf(d2) : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const thetaYear = -(S * pdf * iv) / (2 * sq) + (call ? -r * K * disc * normCdf(d2) : r * K * disc * normCdf(-d2));
  return {
    price,
    delta: call ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (S * v),
    theta: thetaYear / 365,
    vega: (S * pdf * sq) / 100,
  };
}

/** The volatility at which Black-Scholes gives this price (bisection), or null if no volatility does. */
export function impliedVol({ type, S, K, T, r = 0, price }) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const disc = Math.exp(-r * T);
  const intrinsic = type === 'C' ? Math.max(0, S - K * disc) : Math.max(0, K * disc - S);
  const cap = type === 'C' ? S : K * disc;
  if (price <= intrinsic || price >= cap) return null;
  const at = (iv) => blackScholes({ type, S, K, T, r, iv }).price;
  let lo = 1e-4, hi = 5;
  if (at(hi) < price || at(lo) > price) return null;
  for (let i = 0; i < 100 && hi - lo > 1e-7; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Chain statistics
// ---------------------------------------------------------------------------

/** Bid/ask midpoint when both sides are quoted. */
export const midOf = (c) => (c && c.bid > 0 && c.ask > 0 && c.ask >= c.bid ? (c.bid + c.ask) / 2 : null);
/** A contract's best price: mid, else Deribit's mark, else the last trade. */
const priceOf = (c) => (c ? midOf(c) ?? c.mark ?? c.last ?? null : null);

/**
 * Max pain: the strike at which the options of this expiry are worth least to their holders at
 * expiry (sum of open interest × intrinsic value). Null without open interest.
 */
export function maxPain(rows) {
  let best = null, bestPay = Infinity, total = 0;
  for (const r of rows) total += (r.call?.oi || 0) + (r.put?.oi || 0);
  if (!total) return null;
  for (const at of rows) {
    let pay = 0;
    for (const r of rows) {
      if (r.call?.oi && at.strike > r.strike) pay += r.call.oi * (at.strike - r.strike);
      if (r.put?.oi && at.strike < r.strike) pay += r.put.oi * (r.strike - at.strike);
    }
    if (pay < bestPay) { bestPay = pay; best = at.strike; }
  }
  return best;
}

/** Put/call ratios: by volume and by open interest (null when there are no calls to divide by). */
export function putCallRatio(rows) {
  let cv = 0, pv = 0, co = 0, po = 0;
  for (const r of rows) {
    cv += r.call?.volume || 0; pv += r.put?.volume || 0;
    co += r.call?.oi || 0; po += r.put?.oi || 0;
  }
  return { volume: cv ? pv / cv : null, oi: co ? po / co : null, callVolume: cv, putVolume: pv, callOi: co, putOi: po };
}

/** The at-the-money row: the strike nearest the price, preferring strikes with both a call and a put. */
export function atmRow(rows, S) {
  let best = null;
  for (const r of rows) {
    const both = !!(r.call && r.put);
    if (!best || (both && !best.both) || (both === best.both && Math.abs(r.strike - S) < Math.abs(best.r.strike - S))) best = { r, both };
  }
  return best?.r || null;
}

/**
 * The expected move to expiry: the at-the-money straddle (call + put, at mid when quoted) and
 * one standard deviation from the at-the-money IV (S × IV × √T).
 */
export function expectedMove(rows, S, T) {
  const atm = atmRow(rows, S);
  if (!atm) return { strike: null, iv: null, straddle: null, sigma: null };
  const ivs = [atm.call?.iv, atm.put?.iv].filter((v) => v > 0);
  const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const c = priceOf(atm.call), p = priceOf(atm.put);
  return {
    strike: atm.strike,
    iv,
    straddle: c != null && p != null ? c + p : null,
    sigma: iv && S > 0 && T > 0 ? S * iv * Math.sqrt(T) : null,
  };
}

/** Contracts traded far more than their open interest: new positions. Biggest ratio first. */
export function unusualActivity(rows, { minVolume = 100, ratio = UNUSUAL_RATIO, limit = 15 } = {}) {
  const out = [];
  for (const r of rows) {
    for (const [type, c] of [['C', r.call], ['P', r.put]]) {
      if (!c || c.volume < minVolume || c.volume < ratio * c.oi) continue;
      out.push({ symbol: c.symbol, type, strike: r.strike, volume: c.volume, oi: c.oi, ratio: c.oi ? c.volume / c.oi : null, last: c.last, iv: c.iv ?? null });
    }
  }
  return out.sort((a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity) || b.volume - a.volume).slice(0, limit);
}

/**
 * Which IV a contract has: Deribit's mark IV; Yahoo's when the contract is quoted, else solved
 * from its price. A last trade is solved with the time to expiry it had then (expiresAt, traded:
 * seconds): a 0DTE contract last traded hours ago, solved with the minutes left now, shows an
 * IV several times too high.
 */
function contractIv(source, c, type, S, K, T, r, { expiresAt, now } = {}) {
  if (source === 'deribit') return c.ivQuoted > 0 ? c.ivQuoted : impliedVol({ type, S, K, T, r, price: c.mark });
  const mid = midOf(c);
  // Outside market hours Yahoo has no bids or asks and its IVs are placeholders (0.00001, 0.5...).
  if (mid != null && c.ivQuoted >= 0.02 && c.ivQuoted <= 5) return c.ivQuoted;
  if (mid != null) return impliedVol({ type, S, K, T, r, price: mid });
  if (!c.last) return null;
  const then = c.traded > 0 && c.traded * 1000 < now && expiresAt > c.traded ? Math.max((expiresAt - c.traded) / YEAR, MIN_T) : T;
  return impliedVol({ type, S, K, T: then, r, price: c.last });
}

/**
 * Adds Greeks, IV, mid and in-the-money to every contract, plus the chain's statistics
 * (stats: spot, days, ATM strike and IV, straddle, 1σ move, put/call ratios, max pain) and
 * unusual activity. now: ms.
 */
export function analyzeChain(chain, { now = Date.now() } = {}) {
  const r = chain.source === 'deribit' ? 0 : RISK_FREE;
  const S = chain.underlying.forward ?? chain.underlying.price;
  const years = (chain.expiresAt * 1000 - now) / 1000 / YEAR;
  const T = Math.max(years, MIN_T);
  let quoted = 0;
  const contract = (c, type, K) => {
    if (!c) return null;
    const { ivQuoted, ...rest } = c;
    const mid = midOf(c);
    if (mid != null) quoted++;
    const iv = S > 0 ? contractIv(chain.source, c, type, S, K, T, r, { expiresAt: chain.expiresAt, now }) : null;
    const g = iv ? blackScholes({ type, S, K, T, r, iv }) : null;
    return {
      ...rest,
      mid: sig(mid, 6),
      iv: sig(iv, 4),
      itm: S > 0 ? (type === 'C' ? K < S : K > S) : false,
      delta: sig(g?.delta, 4),
      gamma: sig(g?.gamma, 4),
      theta: sig(g?.theta, 4),
      vega: sig(g?.vega, 4),
    };
  };
  const rows = chain.rows.map((row) => ({ strike: row.strike, call: contract(row.call, 'C', row.strike), put: contract(row.put, 'P', row.strike) }));
  const pcr = putCallRatio(rows);
  const move = expectedMove(rows, S, T);
  const oiMissing = !(pcr.callOi + pcr.putOi);
  const minVolume = chain.source === 'deribit' ? UNUSUAL_MIN[chain.unit] ?? 5 : UNUSUAL_MIN.yahoo;
  return {
    ...chain,
    rate: r,
    rows,
    stats: {
      spot: S,
      days: sig(Math.max(0, years * 365), 4),
      atmStrike: move.strike,
      atmIv: sig(move.iv, 4),
      straddle: sig(move.straddle, 6),
      straddlePct: move.straddle != null && S > 0 ? sig((move.straddle / S) * 100, 4) : null,
      sigmaMove: sig(move.sigma, 6),
      sigmaPct: move.sigma != null && S > 0 ? sig((move.sigma / S) * 100, 4) : null,
      pcVolume: sig(pcr.volume, 4),
      pcOi: sig(pcr.oi, 4),
      callVolume: sig(pcr.callVolume, 9), putVolume: sig(pcr.putVolume, 9), callOi: sig(pcr.callOi, 9), putOi: sig(pcr.putOi, 9),
      maxPain: maxPain(rows),
      quoted, // contracts with a bid and an ask (0: market closed, prices are last trades)
      oiMissing,
    },
    unusual: oiMissing ? [] : unusualActivity(rows, { minVolume }),
  };
}

// ---------------------------------------------------------------------------
// Fetching and caching
// ---------------------------------------------------------------------------

// Both caches live in the desktop app's main process, so they hold the small normalized chains
// (not Yahoo's raw ~200 KB answers) and are capped: at most CACHE_MAX entries, each dropped
// STALE_KEEP after it went stale (until then it stands in when a refetch fails).
const CACHE_MAX = 50;
const STALE_KEEP = 5 * 60 * 1000;
const cache = new Map(); // key -> { t, ttl, data }: a Yahoo page's normalized chain, a Deribit book
const bodies = new Map(); // chain key -> { t, ttl, body }: the gzipped /api/options answer for cache entry t
const inflight = new Map();

/** For tests: forget cached answers. */
export function clearOptionsCache() { cache.clear(); bodies.clear(); inflight.clear(); }

/** For tests: how many entries the caches hold. */
export const optionsCacheSize = () => ({ chains: cache.size, bodies: bodies.size });

/** Puts an entry last (newest) in map, dropping long-stale entries and the oldest past CACHE_MAX. */
function remember(map, key, entry) {
  const now = Date.now();
  map.delete(key);
  map.set(key, entry);
  for (const [k, e] of map) if (now - e.t > e.ttl + STALE_KEEP) map.delete(k);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

/** The cached answer of load() for key, refetched after ttl; the last good copy when a refetch fails. */
async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit;
  if (!inflight.has(key)) {
    inflight.set(key, load().then((data) => {
      const entry = { t: Date.now(), ttl, data };
      remember(cache, key, entry);
      return entry;
    }).finally(() => inflight.delete(key)));
  }
  try {
    return await inflight.get(key);
  } catch (e) {
    if (hit) return hit;
    throw e;
  }
}

async function yahooOptions(ticker, date, deps, retry = true) {
  const sess = await deps.getYahooSession();
  const q = new URLSearchParams({ crumb: sess.crumb });
  if (date) q.set('date', String(date));
  const r = await deps.fetchImpl(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?${q}`, {
    headers: { 'User-Agent': UA, Cookie: sess.cookie, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await deps.getYahooSession(true); return yahooOptions(ticker, date, deps, false); }
  // Yahoo answers 404 for symbols it doesn't know: no options.
  if (r.status === 404) return { optionChain: { result: [] } };
  if (!r.ok) throw Object.assign(new Error(`Couldn't load options from Yahoo (HTTP ${r.status})`), { status: 502 });
  return r.json();
}

async function deribitBook(currency, fetchImpl) {
  const r = await fetchImpl(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`Couldn't load options from Deribit (HTTP ${r.status})`), { status: 502 });
  return r.json();
}

/**
 * The chain of one expiry for an optionsQuery(), unanalysed: { key, t, ttl, chain } (key: the
 * cache entry it came from, t: when that was fetched) or { none: { symbol, none } }.
 */
async function resolveChain(q, { fetchImpl = globalThis.fetch, getYahooSession, now = Date.now() } = {}) {
  if (q.error) throw Object.assign(new Error(q.error), { status: 400 });
  if (q.none) return { none: { symbol: q.full, none: q.none } };
  if (q.source === 'deribit') {
    const { t, data } = await cached(`deribit:${q.currency}`, DERIBIT_TTL, () => deribitBook(q.currency, fetchImpl));
    const chain = normalizeDeribit(data, { currency: q.currency, symbol: q.full, expiry: q.expiry, now });
    return { key: `deribit:${q.full}:${chain.expiry}`, t, ttl: DERIBIT_TTL, chain };
  }
  const deps = { fetchImpl, getYahooSession };
  // A page of Yahoo's (date: null for its default, the nearest expiry), kept normalized. Every
  // page lists all the expiries and has the quote.
  const page = async (date) => {
    const key = `yahoo:${q.ticker}:${date ?? ''}`;
    const { t, data } = await cached(key, YAHOO_TTL, async () => normalizeYahoo(await yahooOptions(q.ticker, date, deps), { symbol: q.full, now }));
    return { key, t, ttl: YAHOO_TTL, chain: data };
  };
  const dated = async (want) => {
    const p = await page(want);
    if (p.chain.none) throw Object.assign(new Error('Yahoo returned no contracts for this expiry'), { status: 502 });
    return p;
  };
  // An expiry asked for (the panel asks for the one it shows): its own page straight away.
  if (q.expiry != null) {
    const direct = await page(q.expiry);
    if (!direct.chain.none) {
      const want = pickExpiry(direct.chain.expiries, q.expiry, now);
      return want === q.expiry ? direct : dated(want); // not (or no longer) an expiry: the next one
    }
    // None: a date Yahoo doesn't know (any more). Its default page says whether there are options.
  }
  const base = await page(null);
  if (base.chain.none) return { none: base.chain };
  const want = pickExpiry(base.chain.expiries, q.expiry, now);
  return want === base.chain.expiry ? base : dated(want);
}

/**
 * The /api/options answer for an optionsQuery(): the analysed chain of one expiry (see
 * normalizeYahoo / normalizeDeribit and analyzeChain) with `updated` (ms), or { symbol, none }.
 * deps: { fetchImpl, getYahooSession } (server.mjs's), now (ms).
 */
export async function optionsChain(q, deps = {}) {
  const r = await resolveChain(q, deps);
  if (r.none) return r.none;
  return analyzeChain({ ...r.chain, updated: r.t }, { now: deps.now ?? Date.now() });
}

/**
 * optionsChain()'s answer as gzipped JSON, for server.mjs: analysed and compressed once per
 * fetched copy of the chain, so the panel's polling (and several windows) cost a lookup.
 */
export async function optionsBody(q, deps = {}) {
  const r = await resolveChain(q, deps);
  if (r.none) return gzipSync(JSON.stringify(r.none));
  const hit = bodies.get(r.key);
  if (hit && hit.t === r.t) return hit.body;
  const body = gzipSync(JSON.stringify(analyzeChain({ ...r.chain, updated: r.t }, { now: deps.now ?? Date.now() })));
  remember(bodies, r.key, { t: r.t, ttl: r.ttl, body });
  return body;
}
