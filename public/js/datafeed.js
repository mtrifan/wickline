// Market data. Everything runs in the browser; the server is optional (see env.js).
//  BINANCE   crypto spot          — direct from the browser; every trade over WebSocket
//  BINANCEF  crypto perpetuals    — Binance USDⓈ-M futures, same as above
//  COINBASE  crypto spot (USD)    — direct from the browser; every trade over WebSocket
//  BYBIT, BYBITF, OKX, OKXF  Bybit and OKX spot and perpetuals — see crypto-exchanges.js
//  YAHOO     stocks, ETFs, funds, indices, forex, futures, bonds — Yahoo through the optional
//            server, or Twelve Data (visitor's free key) + Yahoo's live stream on a static site

import { apiUrl, dataMode } from './env.js';
import { YahooDirectStream } from './yahoo-direct.js';
import { tdBars, tdSearch, tdQuotes } from './twelvedata.js';
import { store } from './util.js';
import { t } from './i18n.js';
import { tfById, basePlan, aggregateUtc, groupBars, utcBucket, sessionStart } from './timeframes.js';
import { EXCHANGE_SOURCES, isExchangeSource, ExchangeFeed, exchangeMarket, exchangeList, streamExchangeQuotes } from './crypto-exchanges.js';

// Any timeframe works (see timeframes.js); these are the ones the app has always had.
export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M'].map(tfById);
export { tfById };

export const SOURCES = {
  BINANCE: { name: 'Binance', crypto: true },
  BINANCEF: { name: 'Binance Futures', crypto: true, suffix: '.P' },
  COINBASE: { name: 'Coinbase', crypto: true },
  ...EXCHANGE_SOURCES,
  YAHOO: { name: 'Yahoo Finance', crypto: false },
};

export function parseSymbol(full) {
  const i = full.indexOf(':');
  if (i < 0) return { source: 'YAHOO', ticker: full };
  return { source: full.slice(0, i).toUpperCase(), ticker: full.slice(i + 1) };
}

/** Ticker as shown to people, e.g. BTCUSDT.P for a perpetual. */
export function displayTicker(full) {
  const { source, ticker } = parseSymbol(full);
  return ticker + (SOURCES[source]?.suffix || '');
}

export const sourceName = (full) => SOURCES[parseSymbol(full).source]?.name || 'Yahoo Finance';
export const isCryptoSymbol = (full) => !!SOURCES[parseSymbol(full).source]?.crypto;

/** Seconds to add to UTC so intraday crypto bars show in the viewer's local time. */
const localOffset = () => -new Date().getTimezoneOffset() * 60;

function decimalsFromTick(tick) {
  const s = String(tick).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(body?.error || body?.msg || body?.message || `HTTP ${r.status}`);
    err.status = r.status;
    const wait = Number(r.headers?.get?.('Retry-After')); // seconds (when the server lets us read it)
    if (wait > 0) err.retryAfter = wait;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Binance spot and USDⓈ-M futures
// ---------------------------------------------------------------------------

/** "BTC / USDT", or "BTC / USDT perpetual" for Binance futures (in the UI language). */
const pairName = (src, base, quote) => (SOURCES[src]?.suffix ? t('feed.perpName', { base, quote }) : `${base} / ${quote}`);

const BINANCE = {
  BINANCE: {
    rest: ['https://data-api.binance.vision', 'https://api.binance.com'],
    ws: ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'],
    klines: '/api/v3/klines', ticker24: '/api/v3/ticker/24hr', limit: 1000,
  },
  BINANCEF: {
    rest: ['https://fapi.binance.com'],
    ws: ['wss://fstream.binance.com'],
    // Futures klines weigh 5 up to 1000 a page and 10 above (spot: 2 at any size).
    klines: '/fapi/v1/klines', ticker24: '/fapi/v1/ticker/24hr', limit: 1000,
  },
};
const restIndex = { BINANCE: 0, BINANCEF: 0 };
// Binance answers too many requests with 429 and, if they keep coming, 418: the IP is banned for
// minutes to days. After either, no more requests to that market until it says (or a while).
const backoffUntil = { BINANCE: 0, BINANCEF: 0 };

async function binanceGet(src, path) {
  if (Date.now() < backoffUntil[src]) {
    throw Object.assign(new Error(t('feed.backoff', { source: SOURCES[src].name })), { status: 429 });
  }
  const hosts = BINANCE[src].rest;
  let lastErr;
  for (let k = 0; k < hosts.length; k++) {
    const idx = (restIndex[src] + k) % hosts.length;
    try {
      const body = await getJson(hosts[idx] + path);
      restIndex[src] = idx;
      return body;
    } catch (e) {
      lastErr = e.status ? e : new Error(t('feed.unreachable', { source: SOURCES[src].name }));
      if (e.status === 400) break; // invalid symbol etc. — another host will say the same
    }
  }
  if (lastErr.status === 429 || lastErr.status === 418) {
    const wait = lastErr.retryAfter > 0 ? lastErr.retryAfter * 1000 : lastErr.status === 418 ? 120000 : 30000;
    backoffUntil[src] = Math.max(backoffUntil[src], Date.now() + wait);
  }
  throw lastErr;
}

let futuresInfo = null;
const futuresExchangeInfo = () => (futuresInfo ||= binanceGet('BINANCEF', '/fapi/v1/exchangeInfo').catch((e) => { futuresInfo = null; throw e; }));

/**
 * Crypto timeframes the exchange doesn't have are grouped from a smaller interval, on a UTC grid
 * that restarts each day like the exchange's own bars. Feeds use this for live trades too.
 */
function cryptoBucketOf(feed) {
  return feed.tf.daily ? null : (t) => utcBucket(t - feed.shift, feed.tf) + feed.shift;
}

class BinanceFeed {
  constructor(src, ticker, tf) {
    this.src = src;
    this.cfg = BINANCE[src];
    this.ticker = ticker.toUpperCase();
    this.tf = tf;
    // e.g. 10m from 5m klines: enough pages of them for about as many bars as a native interval.
    this.plan = basePlan(tf, 'binance');
    this.interval = this.plan.native;
    this.baseMs = this.plan.base.sec * 1000;
    this.pages = this.plan.agg ? Math.min(6, this.plan.factor) : 1;
    this.shift = tf.daily ? 0 : localOffset();
    this.canLoadMore = true;
    this.ws = null;
    this.closed = false;
    this.recent = new Map(); // grouped timeframes: base klines (UTC) of the newest bar, by open time
    this.liveStart = -Infinity; // ...and that bar's start (UTC)
    this.seeded = false;
    this.seedTimer = null;
    this.bucketOf = cryptoBucketOf(this);
  }

  rawBar(k) {
    return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
  }

  /** UTC klines → chart bars (grouped when the timeframe isn't native, in the viewer's time). */
  toChart(raw) {
    const bars = this.plan.agg ? aggregateUtc(raw, this.tf) : raw;
    return bars.map((b) => ({ ...b, time: b.time + this.shift }));
  }

  /**
   * `pages` pages of klines ending at endMs (now if null), oldest first. Two at a time, each pair
   * continuing before the oldest kline so far, and none after a short page (the start of the
   * history): Binance meters requests by weight and answers bursts with bans (see binanceGet).
   * The newest page comes first on its own: the exchange's "now", not this computer's clock
   * (which may be off), sets where the older pages end.
   */
  async fetchRaw(endMs) {
    const limit = this.cfg.limit;
    const span = limit * this.baseMs;
    const pages = []; // newest first
    let end = endMs; // null: up to now
    for (let k = 0; k < this.pages;) {
      const n = end == null ? 1 : Math.min(2, this.pages - k);
      let batch;
      try {
        batch = await Promise.all(Array.from({ length: n }, (_, j) => binanceGet(this.src,
          `${this.cfg.klines}?symbol=${this.ticker}&interval=${this.interval}&limit=${limit}${end == null ? '' : `&endTime=${end - j * span}`}`)));
      } catch (e) {
        if (!pages.length) throw e;
        break; // keep what came; scrolling back continues from there (after any back-off)
      }
      pages.push(...batch);
      k += n;
      const last = batch[n - 1];
      if (last.length < limit) { this.canLoadMore = false; break; }
      end = last[0][0] - 1;
    }
    const seen = new Set();
    return pages.reverse().flat().map((k) => this.rawBar(k)).filter((b) => (seen.has(b.time) ? false : seen.add(b.time)));
  }

  /**
   * Grouped timeframes: remember the klines (oldest first) of the newest bar, to keep building it
   * live from the kline stream. A late update of an older kline is ignored.
   */
  remember(raw) {
    if (!this.plan.agg) return;
    for (const b of raw) {
      const start = utcBucket(b.time, this.tf);
      if (start < this.liveStart) continue;
      if (start > this.liveStart) { this.liveStart = start; this.recent.clear(); }
      const have = this.recent.get(b.time);
      if (!have || b.volume >= have.volume) this.recent.set(b.time, b); // a kline's volume only grows
    }
  }

  /** The newest grouped bar, from the remembered klines. */
  liveBar() {
    const parts = [...this.recent.values()].sort((a, b) => a.time - b.time);
    if (!parts.length) return null;
    return { ...groupBars(parts, () => this.liveStart)[0], time: this.liveStart + this.shift };
  }

  async symbolInfo() {
    if (this.src === 'BINANCE') return (await binanceGet('BINANCE', `/api/v3/exchangeInfo?symbol=${this.ticker}`)).symbols?.[0];
    return (await futuresExchangeInfo()).symbols?.find((s) => s.symbol === this.ticker);
  }

  async loadInitial() {
    const [s, raw] = await Promise.all([
      this.symbolInfo().catch(() => null),
      this.fetchRaw(null),
    ]);
    const tick = s?.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01';
    this.remember(raw);
    this.seeded = true;
    return {
      meta: {
        symbol: this.ticker,
        name: s?.baseAsset ? pairName(this.src, s.baseAsset, s.quoteAsset) : this.ticker,
        exchange: SOURCES[this.src].name,
        currency: s?.quoteAsset || '',
        type: 'crypto',
        precision: Math.min(decimalsFromTick(tick), 8),
        tzOffset: this.shift,
      },
      bars: this.toChart(raw),
    };
  }

  async loadOlder(firstTime) {
    if (!this.canLoadMore) return [];
    // The first bar starts a full bar, so the klines before it make whole bars.
    const raw = await this.fetchRaw((firstTime - this.shift) * 1000 - 1);
    return this.toChart(raw).filter((b) => b.time < firstTime);
  }

  /**
   * The kline stream gives the official bar every ~2 s; the trade stream moves the price on every
   * trade. Grouped timeframes (10m from 5m klines) rebuild their newest bar from its klines.
   */
  subscribe({ bars, tick, status }) {
    let host = 0, retry = 0;
    const sym = this.ticker.toLowerCase();
    const emitLive = () => { const b = this.liveBar(); if (b) bars([b]); };
    // After a reconnect, klines may have been missed: fetch the newest bar's klines again first.
    // Until that works the grouped bar gets no official updates, so a failure is retried (2 s,
    // 4 s … up to a minute) while this connection lasts.
    let seedTry = 0;
    const seed = async (ws) => {
      clearTimeout(this.seedTimer);
      try {
        const startMs = utcBucket(Math.floor(Date.now() / 1000), this.tf) * 1000;
        const rows = await binanceGet(this.src, `${this.cfg.klines}?symbol=${this.ticker}&interval=${this.interval}&startTime=${startMs}&limit=1000`);
        if (this.closed || ws !== this.ws) return;
        this.remember(rows.map((k) => this.rawBar(k)));
        this.seeded = true;
        emitLive();
      } catch {
        if (this.closed || this.seeded || ws !== this.ws) return;
        this.seedTimer = setTimeout(() => seed(ws), Math.min(2000 * 2 ** seedTry++, 60000));
      }
    };
    const connect = () => {
      if (this.closed) return;
      status('connecting');
      const ws = new WebSocket(`${this.cfg.ws[host]}/stream?streams=${sym}@kline_${this.interval}/${sym}@aggTrade`);
      this.ws = ws;
      ws.onopen = () => {
        retry = 0;
        status('live');
        if (this.plan.agg && !this.seeded) { seedTry = 0; seed(ws); }
      };
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data).data;
        if (!d) return;
        if (d.e === 'aggTrade') tick({ time: Math.floor(d.T / 1000) + this.shift, price: +d.p, volume: +d.q });
        else if (d.k) {
          const k = d.k;
          const raw = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
          if (!this.plan.agg) { bars([{ ...raw, time: raw.time + this.shift }]); return; }
          this.remember([raw]);
          if (this.seeded) emitLive();
        }
      };
      ws.onclose = () => {
        clearTimeout(this.seedTimer);
        if (this.closed) return;
        this.seeded = false;
        status('reconnecting');
        host = (host + 1) % this.cfg.ws.length;
        setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.seedTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Coinbase
// ---------------------------------------------------------------------------

const COINBASE_REST = 'https://api.exchange.coinbase.com';
const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';
// Coinbase serves 1m/5m/15m/1h/6h/1D candles; other timeframes are built from these (timeframes.js).
class CoinbaseFeed {
  constructor(ticker, tf) {
    this.ticker = ticker.toUpperCase();
    this.tf = tf;
    const plan = basePlan(tf, 'coinbase');
    this.gran = plan.native;
    this.agg = plan.agg;
    this.shift = tf.daily ? 0 : localOffset();
    this.canLoadMore = true;
    this.closed = false;
    this.ws = null;
    this.timer = null;
    // Enough 300-candle pages to show a useful number of (possibly grouped) bars.
    this.pages = Math.max(1, Math.min(6, plan.factor));
    this.bucketOf = cryptoBucketOf(this);
  }

  async page(endSec) {
    const start = endSec - this.gran * 300;
    const iso = (s) => new Date(s * 1000).toISOString();
    const rows = await getJson(`${COINBASE_REST}/products/${this.ticker}/candles?granularity=${this.gran}&start=${iso(start)}&end=${iso(endSec)}`);
    return rows.map((r) => ({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] })).sort((a, b) => a.time - b.time);
  }

  async fetchBack(endSec, pages) {
    let all = [], end = endSec;
    for (let p = 0; p < pages; p++) {
      const rows = await this.page(end);
      if (!rows.length) { this.canLoadMore = false; break; }
      all = rows.concat(all);
      end = rows[0].time - 1;
    }
    const seen = new Set();
    return all.filter((b) => (seen.has(b.time) ? false : seen.add(b.time)));
  }

  /** UTC candles → chart bars; a grouped first bar missing its start is dropped (timeframes.js). */
  toChart(raw) {
    const bars = this.agg ? aggregateUtc(raw, this.tf) : raw;
    return bars.map((b) => ({ ...b, time: b.time + this.shift }));
  }

  async loadInitial() {
    const [product, raw] = await Promise.all([
      getJson(`${COINBASE_REST}/products/${this.ticker}`),
      this.fetchBack(Math.floor(Date.now() / 1000), this.pages),
    ]);
    return {
      meta: {
        symbol: this.ticker,
        name: product.display_name ? product.display_name.replace('-', ' / ') : this.ticker,
        exchange: 'Coinbase',
        currency: product.quote_currency || '',
        type: 'crypto',
        precision: Math.min(decimalsFromTick(product.quote_increment || '0.01'), 8),
        tzOffset: this.shift,
      },
      bars: this.toChart(raw),
    };
  }

  async loadOlder(firstTime) {
    if (!this.canLoadMore) return [];
    const raw = await this.fetchBack(firstTime - this.shift - 1, this.pages);
    return this.toChart(raw).filter((b) => b.time < firstTime);
  }

  subscribe({ bars, tick, status }) {
    let retry = 0;
    const connect = () => {
      if (this.closed) return;
      status('connecting');
      const ws = new WebSocket(COINBASE_WS);
      this.ws = ws;
      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ type: 'subscribe', product_ids: [this.ticker], channels: ['matches'] }));
        status('live');
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'match' || m.type === 'last_match') {
          tick({ time: Math.floor(Date.parse(m.time) / 1000) + this.shift, price: +m.price, volume: +m.size });
        }
      };
      ws.onclose = () => {
        if (this.closed) return;
        status('reconnecting');
        setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    // Re-sync with the official candles once a minute.
    const poll = async () => {
      if (this.closed) return;
      try { bars(this.toChart(await this.page(Math.floor(Date.now() / 1000)))); } catch { /* keep streaming */ }
      if (!this.closed) this.timer = setTimeout(poll, 60000);
    };
    this.timer = setTimeout(poll, 60000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Stocks, ETFs, funds, indices, forex, futures ("YAHOO:" symbols)
//  server mode: Yahoo through the optional server.
//  static mode: history from Twelve Data (visitor's key), live prices from Yahoo's stream directly.
// ---------------------------------------------------------------------------

/**
 * One live-price connection per page for all Yahoo symbols (charts, watchlist, markets and
 * alerts share it): Server-Sent Events from the server, or Yahoo's WebSocket directly.
 */
class YahooLive {
  constructor() {
    this.subs = new Map(); // symbol -> Set(callback)
    this.es = null;
    this.key = '';
    this.timer = null;
    this.direct = new YahooDirectStream((t) => this.dispatch(t));
  }

  dispatch(t) {
    const set = this.subs.get(t.s);
    if (set) for (const cb of set) cb(t);
  }

  subscribe(symbol, cb) {
    if (!this.subs.has(symbol)) this.subs.set(symbol, new Set());
    this.subs.get(symbol).add(cb);
    this.schedule();
    return () => {
      const set = this.subs.get(symbol);
      if (!set) return;
      set.delete(cb);
      if (!set.size) this.subs.delete(symbol);
      this.schedule();
    };
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reopen(), 200);
  }

  async reopen() {
    if ((await dataMode()) !== 'server') {
      this.direct.setSymbols([...this.subs.keys()]);
      return;
    }
    const key = [...this.subs.keys()].sort().join(',');
    if (key === this.key && this.es) return;
    this.key = key;
    this.es?.close();
    this.es = null;
    if (!key) return;
    this.es = new EventSource(apiUrl(`api/yahoo/stream?symbols=${encodeURIComponent(key)}`));
    this.es.onmessage = (e) => {
      let t;
      try { t = JSON.parse(e.data); } catch { return; }
      this.dispatch(t);
    };
  }
}

// Names of every US stock and ETF from the bundled lists (static mode), for chart titles.
let namesPromise = null;
function usNames() {
  namesPromise ||= Promise.all(['us-stocks', 'us-etfs'].map((id) => getJson(`data/${id}.json`).catch(() => [])))
    .then((lists) => new Map(lists.flat().map((r) => [r.s, r.n])));
  return namesPromise;
}

export const yahooLive = new YahooLive();

const PRE_MARKET = 0, REGULAR_SESSION = 1, AFTER_HOURS = 2; // Yahoo marketHours; others = overnight

/** Extended hours: on intraday charts, pre-market, after-hours and overnight trades build candles too. */
export const extendedHours = {
  get on() { return store.get('extHours', true); },
  set on(v) { store.set('extHours', !!v); },
};

class YahooFeed {
  constructor(ticker, tf) {
    this.ticker = ticker;
    this.tf = tf;
    // Daily and longer bars are always the regular session (that's what the exchange reports).
    this.ext = !tf.daily && extendedHours.on;
    this.canLoadMore = false; // server mode already loads the deepest history Yahoo allows
    this.timer = null;
    this.quietTimer = null;
    this.unsub = null;
    this.tzOffset = 0;
    this.sessionOpen = null; // seconds after midnight (exchange time) the session opens: see bucketOf
    this.dayVolume = null;
    this.closed = false;
    this.server = false;
  }

  url(live) {
    const p = new URLSearchParams({ symbol: this.ticker, tf: this.tf.id });
    if (live) p.set('live', '1');
    if (this.ext) p.set('prepost', '1');
    return apiUrl(`api/yahoo/chart?${p}`);
  }

  async loadInitial() {
    this.server = (await dataMode()) === 'server';
    // Twelve Data history (static site) is regular-session only, so extended-hours candles
    // wouldn't connect to it: show those trades as the price line instead.
    if (!this.server) this.ext = false;
    const res = this.server ? await getJson(this.url(false)) : await tdBars(this.ticker, this.tf);
    if (!this.server) {
      this.canLoadMore = res.full;
      const name = (await usNames()).get(this.ticker);
      if (name) res.meta.name = name; // company name for US stocks and ETFs
    }
    this.tzOffset = res.meta?.tzOffset || 0;
    this.sessionOpen = Number.isFinite(res.meta?.sessionOpen) ? res.meta.sessionOpen : null;
    return res;
  }

  /**
   * The bar a live trade starts when it's the first of a new session: that session's grid (from
   * its open), not the last session's carried on, which for sizes that don't divide a day (25m,
   * 7m, 5h) would land between the official bars. Null: the chart's own rule (same session).
   */
  bucketOf(t, lastTime) {
    if (this.tf.daily || this.sessionOpen == null || lastTime == null) return null;
    const start = sessionStart(t, this.sessionOpen);
    if (lastTime >= start) return null;
    return start + Math.floor((t - start) / this.tf.sec) * this.tf.sec;
  }

  async loadOlder(firstTime) {
    if (this.server || !this.canLoadMore) return [];
    const res = await tdBars(this.ticker, this.tf, { before: firstTime, open: this.sessionOpen });
    this.canLoadMore = res.full;
    return res.bars.filter((b) => b.time < firstTime);
  }

  subscribe({ bars, tick, status, extended }) {
    let streaming = false;
    const quiet = (ms = 90000) => {
      clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => { streaming = false; if (!this.closed) status('polling'); }, ms);
    };
    this.unsub = yahooLive.subscribe(this.ticker, (t) => {
      if (this.closed) return;
      if (!streaming) { streaming = true; status('live'); }
      quiet();
      // Candles: the regular session, plus pre-market and after-hours when extended hours are on
      // (both have full history). Overnight trades have no candle history in any free source, so
      // they're shown as a price line instead of candles that wouldn't connect to the history.
      const candle = t.m === REGULAR_SESSION || (this.ext && (t.m === PRE_MARKET || t.m === AFTER_HOURS));
      if (!candle) {
        extended?.({ price: t.p, session: t.m, time: t.t });
        return;
      }
      extended?.(null);
      let volume = 0;
      if (t.v != null) {
        if (this.dayVolume != null && t.v >= this.dayVolume) volume = t.v - this.dayVolume;
        this.dayVolume = t.v;
      }
      tick({ time: Math.floor(t.t / 1000) + this.tzOffset, price: t.p, volume });
    });

    // Re-sync with official bars now and then. On a static site this spends the visitor's
    // Twelve Data credits, so it's rare and only while the market is trading.
    const every = this.server ? (this.tf.daily ? 60000 : 20000) : 5 * 60000;
    const poll = async () => {
      if (this.closed) return;
      try {
        if (this.server) {
          const res = await getJson(this.url(true));
          if (this.closed) return;
          if (!streaming) status('polling');
          bars(res.bars);
        } else if (streaming) {
          // Grouped timeframes rebuild today's bars, so they ask from the day's start (exchange time).
          const since = Math.floor((Date.now() / 1000 + this.tzOffset) / 86400) * 86400;
          const res = await tdBars(this.ticker, this.tf, { outputsize: 5, since, open: this.sessionOpen });
          if (!this.closed) bars(res.bars);
        }
      } catch {
        if (!this.closed && !streaming) status('error');
      }
      if (!this.closed) this.timer = setTimeout(poll, every);
    };
    status('connecting');
    this.timer = setTimeout(poll, every);
    quiet(8000); // market closed? say so after a few seconds without trades
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.quietTimer);
    this.unsub?.();
  }
}

export function createFeed(symbol, tf) {
  const { source, ticker } = parseSymbol(symbol);
  if (source === 'BINANCE' || source === 'BINANCEF') return new BinanceFeed(source, ticker, tf);
  if (source === 'COINBASE') return new CoinbaseFeed(ticker, tf);
  if (isExchangeSource(source)) return new ExchangeFeed(source, ticker, tf);
  return new YahooFeed(ticker, tf);
}

// ---------------------------------------------------------------------------
// Symbol search
// ---------------------------------------------------------------------------

const PREFERRED_QUOTES = { USDT: 3, USD: 3, USDC: 2, FDUSD: 2, BTC: 1, ETH: 1, EUR: 1 };
const QUOTES = ['FDUSD', 'USDT', 'USDC', 'BTC', 'ETH', 'EUR', 'BNB', 'TRY', 'BRL', 'JPY'];
const quoteOf = (sym) => QUOTES.find((q) => sym.endsWith(q) && sym.length > q.length) || '';

const lists = {};
function cachedList(key, load) {
  if (!lists[key]) lists[key] = load().catch((e) => { lists[key] = null; throw e; });
  return lists[key];
}

const binanceList = (src) => cachedList(src, async () => {
  const rows = await binanceGet(src, src === 'BINANCE' ? '/api/v3/ticker/24hr?type=MINI' : '/fapi/v1/ticker/24hr');
  return rows.filter((r) => Number(r.count) > 0).map((r) => {
    const quote = quoteOf(r.symbol);
    return { ticker: r.symbol, base: quote ? r.symbol.slice(0, -quote.length) : r.symbol, quote, rank: Number(r.count) };
  });
});

const coinbaseList = () => cachedList('COINBASE', async () => {
  const rows = await getJson(`${COINBASE_REST}/products`);
  return rows.filter((p) => p.status === 'online' && !p.trading_disabled).map((p) => ({
    ticker: p.id, base: p.base_currency, quote: p.quote_currency, rank: PREFERRED_QUOTES[p.quote_currency] || 0,
  }));
});

/** Warms the crypto symbol lists (called when the search opens). */
export function warmSymbolLists() {
  binanceList('BINANCE').catch(() => {});
  binanceList('BINANCEF').catch(() => {});
  coinbaseList().catch(() => {});
  for (const src of Object.keys(EXCHANGE_SOURCES)) exchangeList(src).catch(() => {});
}

async function searchList(src, list, q, limit) {
  const Q = q.toUpperCase().replace(/[\s/_]/g, '').replace(/-/g, src === 'COINBASE' ? '-' : '');
  const plain = Q.replace(/-/g, '');
  const scored = [];
  for (const s of await list) {
    const t = s.ticker.replace(/-/g, '');
    let rank;
    if (t === plain || s.base === plain) rank = 0;
    else if (t === `${plain}USDT` || t === `${plain}USD`) rank = 0.5;
    else if (t.startsWith(plain)) rank = 1;
    else if (t.includes(plain)) rank = 2;
    else continue;
    scored.push({ s, rank, pref: PREFERRED_QUOTES[s.quote] || 0 });
  }
  scored.sort((a, b) => a.rank - b.rank || b.pref - a.pref || b.s.rank - a.s.rank);
  return scored.slice(0, limit).map(({ s }) => ({
    full: `${src}:${s.ticker}`,
    ticker: s.ticker + (SOURCES[src].suffix || ''),
    name: pairName(src, s.base, s.quote || '?'),
    exchange: SOURCES[src].name,
    type: SOURCES[src].suffix ? 'Crypto perpetual' : 'Crypto',
    category: 'crypto',
  }));
}

export async function searchCrypto(query, limit = 6) {
  if (!query.trim()) return [];
  const settled = await Promise.allSettled([
    searchList('BINANCE', binanceList('BINANCE'), query, limit),
    searchList('BINANCEF', binanceList('BINANCEF'), query, limit),
    searchList('COINBASE', coinbaseList(), query, limit),
    ...Object.keys(EXCHANGE_SOURCES).map((src) => searchList(src, exchangeList(src), query, Math.min(limit, 4))),
  ]);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

const YAHOO_CATEGORY = {
  EQUITY: 'stocks', ETF: 'funds', MUTUALFUND: 'funds', INDEX: 'indices', FUTURE: 'futures',
  CURRENCY: 'forex', CRYPTOCURRENCY: 'crypto',
};

export async function searchYahoo(query) {
  if ((await dataMode()) !== 'server') return tdSearch(query); // static site: Twelve Data search (no key needed)
  const rows = await getJson(apiUrl(`api/yahoo/search?q=${encodeURIComponent(query)}`));
  return rows.map((r) => ({
    full: `YAHOO:${r.symbol}`,
    ticker: r.symbol,
    name: r.name,
    exchange: r.exchange,
    type: r.type,
    category: YAHOO_CATEGORY[r.quoteType] || 'other',
  }));
}

// ---------------------------------------------------------------------------
// Full market lists for the Markets panel
// ---------------------------------------------------------------------------

/**
 * Every instrument of a market, with last price and change:
 *  us-stocks (all US-listed stocks), us-etfs, binance, binancef, coinbase, bybit, bybitf, okx, okxf.
 * Returns [{ full, ticker, name, price, change, rank, sector }]; rank = popularity (higher first).
 */
export async function loadUniverse(id) {
  const pct = (last, open) => (open ? ((last - open) / open) * 100 : null);
  // US lists: live with prices from the server, or the names-only lists shipped with the site
  // (largest first; prices then fill in from the live stream).
  const usList = async (name) => getJson((await dataMode()) === 'server' ? apiUrl(`api/universe/${name}`) : `data/${name}.json`);
  switch (id) {
    case 'us-stocks':
      return (await usList('us-stocks')).map((r, i, a) => ({
        full: `YAHOO:${r.s}`, ticker: r.s, name: r.n, price: r.p, change: r.c, rank: r.m ?? a.length - i, sector: r.sec,
      }));
    case 'us-etfs':
      return (await usList('us-etfs')).map((r) => ({
        full: `YAHOO:${r.s}`, ticker: r.s, name: r.n, price: r.p, change: r.c, rank: 0,
      }));
    case 'binance':
    case 'binancef': {
      const src = id === 'binance' ? 'BINANCE' : 'BINANCEF';
      const rows = await binanceGet(src, src === 'BINANCE' ? '/api/v3/ticker/24hr?type=MINI' : '/fapi/v1/ticker/24hr');
      return rows.filter((r) => Number(r.count) > 0).map((r) => {
        const quote = quoteOf(r.symbol);
        const base = quote ? r.symbol.slice(0, -quote.length) : r.symbol;
        return {
          full: `${src}:${r.symbol}`,
          ticker: r.symbol + (SOURCES[src].suffix || ''),
          name: pairName(src, base, quote || '?'),
          price: +r.lastPrice,
          change: src === 'BINANCEF' ? +r.priceChangePercent : pct(+r.lastPrice, +r.openPrice),
          rank: Number(r.count),
          sector: quote || t('feed.otherSector'),
        };
      });
    }
    case 'coinbase': {
      const [products, stats] = await Promise.all([getJson(`${COINBASE_REST}/products`), getJson(`${COINBASE_REST}/products/stats`)]);
      return products.filter((p) => p.status === 'online' && !p.trading_disabled).map((p) => {
        const s = stats[p.id]?.stats_24hour || {};
        const last = +s.last;
        return {
          full: `COINBASE:${p.id}`, ticker: p.id, name: `${p.base_currency} / ${p.quote_currency}`,
          price: Number.isFinite(last) ? last : null, change: pct(last, +s.open),
          rank: (+s.volume || 0) * (last || 0) * (p.quote_currency === 'USD' ? 1 : 0.5), sector: p.quote_currency,
        };
      });
    }
    case 'bybit': case 'bybitf': case 'okx': case 'okxf': {
      const src = id.toUpperCase();
      return (await exchangeMarket(src)).map((r) => ({
        full: `${src}:${r.ticker}`, ticker: r.ticker + (SOURCES[src].suffix || ''), name: pairName(src, r.base, r.quote),
        price: r.price, change: r.change, rank: r.rank, sector: r.quote || t('feed.otherSector'),
      }));
    }
    default:
      throw new Error(`Unknown market ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Live quotes for lists (watchlist, markets, alerts)
// ---------------------------------------------------------------------------

/**
 * Streams last price + daily (or 24h for crypto) change for a list of symbols.
 * onQuote(fullSymbol, { price, change, precision })
 * useCredits: on a static site, may spend the visitor's Twelve Data credits on quotes
 * (watchlist and alerts yes; the Markets browser no).
 */
export class QuoteStream {
  constructor(onQuote, { useCredits = false } = {}) {
    this.onQuote = onQuote;
    this.useCredits = useCredits;
    this.sockets = [];
    this.timers = [];
    this.unsubs = [];
    this.symbols = [];
    this.gen = 0;
    this.yahooBase = new Map(); // ticker -> { prevClose, precision, lastTickAt }
  }

  setSymbols(symbols) {
    const next = [...new Set(symbols)];
    if (next.join('|') === this.symbols.join('|')) return;
    this.symbols = next;
    this.restart();
  }

  stop() { this.symbols = []; this.restart(); }

  restart() {
    const gen = ++this.gen;
    for (const ws of this.sockets) { try { ws.close(); } catch { /* ignore */ } }
    this.sockets = [];
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.unsubs.forEach((u) => u());
    this.unsubs = [];

    const by = {};
    for (const s of this.symbols) {
      const { source, ticker } = parseSymbol(s);
      (by[source] ||= []).push(ticker);
    }
    for (const src of ['BINANCE', 'BINANCEF']) if (by[src]) this.startBinance(src, by[src], gen);
    if (by.COINBASE) this.startCoinbase(by.COINBASE, gen);
    for (const src of Object.keys(EXCHANGE_SOURCES)) if (by[src]) streamExchangeQuotes(this, src, by[src], gen);
    const yahoo = Object.entries(by).filter(([k]) => !SOURCES[k]?.crypto).flatMap(([, v]) => v);
    if (yahoo.length) this.startYahoo(yahoo, gen);
  }

  emit(full, price, open) {
    this.onQuote(full, { price, change: open ? ((price - open) / open) * 100 : null });
  }

  startBinance(src, tickers, gen) {
    const cfg = BINANCE[src];
    const snapshot = src === 'BINANCE'
      ? binanceGet(src, `${cfg.ticker24}?type=MINI&symbols=${encodeURIComponent(JSON.stringify(tickers))}`)
      : Promise.all(tickers.map((t) => binanceGet(src, `${cfg.ticker24}?symbol=${t}`).catch(() => null)));
    snapshot.then((rows) => {
      if (gen !== this.gen) return;
      for (const r of rows || []) if (r) this.emit(`${src}:${r.symbol}`, +r.lastPrice, +r.openPrice);
    }).catch(() => {});
    const open = (host) => {
      if (gen !== this.gen) return;
      const streams = tickers.map((t) => `${t.toLowerCase()}@miniTicker`).join('/');
      const ws = new WebSocket(`${cfg.ws[host]}/stream?streams=${streams}`);
      this.sockets.push(ws);
      ws.onmessage = (ev) => {
        const d = JSON.parse(ev.data).data;
        if (d) this.emit(`${src}:${d.s}`, +d.c, +d.o);
      };
      ws.onclose = () => { if (gen === this.gen) this.timers.push(setTimeout(() => open((host + 1) % cfg.ws.length), 3000)); };
      ws.onerror = () => ws.close();
    };
    open(0);
  }

  startCoinbase(tickers, gen) {
    for (const t of tickers) {
      getJson(`${COINBASE_REST}/products/${t}/stats`).then((s) => {
        if (gen === this.gen) this.emit(`COINBASE:${t}`, +s.last, +s.open);
      }).catch(() => {});
    }
    const open = () => {
      if (gen !== this.gen) return;
      const ws = new WebSocket(COINBASE_WS);
      this.sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', product_ids: tickers, channels: ['ticker'] }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === 'ticker') this.emit(`COINBASE:${m.product_id}`, +m.price, +m.open_24h);
      };
      ws.onclose = () => { if (gen === this.gen) this.timers.push(setTimeout(open, 3000)); };
      ws.onerror = () => ws.close();
    };
    open();
  }

  startYahoo(tickers, gen) {
    // Live ticks move the price; a slow poll supplies the previous close for the % change.
    for (const ticker of tickers) {
      this.unsubs.push(yahooLive.subscribe(ticker, (t) => {
        if (gen !== this.gen) return;
        const base = this.yahooBase.get(ticker) || {};
        base.lastTickAt = Date.now();
        this.yahooBase.set(ticker, base);
        const change = base.prevClose ? ((t.p - base.prevClose) / base.prevClose) * 100
          : Number.isFinite(t.cp) ? t.cp : null; // the stream's own % change (static site)
        this.onQuote(`YAHOO:${ticker}`, { price: t.p, change, precision: base.precision });
      }));
    }
    const apply = (rows) => {
      for (const r of rows) {
        const base = this.yahooBase.get(r.symbol) || {};
        Object.assign(base, { prevClose: r.prevClose, precision: r.precision ?? base.precision });
        this.yahooBase.set(r.symbol, base);
        // Don't overwrite a fresher streamed price with the polled one.
        if (!base.lastTickAt || Date.now() - base.lastTickAt > 60000) {
          this.onQuote(`YAHOO:${r.symbol}`, { price: r.price, change: r.change, precision: r.precision, name: r.name });
        }
      }
    };
    const poll = async () => {
      if (gen !== this.gen) return;
      let every = 60000;
      try {
        if ((await dataMode()) === 'server') {
          apply(await getJson(apiUrl(`api/yahoo/quotes?symbols=${encodeURIComponent(tickers.join(','))}`)));
        } else {
          // Static site: prices come from the live stream; the visitor's Twelve Data key, if
          // they added one, also fills in quotes while markets are closed (every 10 minutes).
          every = 10 * 60000;
          if (this.useCredits) {
            const rows = await tdQuotes(tickers);
            if (gen !== this.gen) return;
            apply(rows);
          }
        }
      } catch { /* keep last values */ }
      if (gen === this.gen) this.timers.push(setTimeout(poll, every));
    };
    poll();
  }
}
