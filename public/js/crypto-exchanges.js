// Bybit and OKX: spot pairs and USDT/USDC perpetuals, read straight from the exchanges' public APIs
// (no key; both allow it from a browser). Charts load history over REST and move with every trade
// over WebSocket; lists, search and live quotes for the watchlist come from their ticker feeds.
//
//  BYBIT   Bybit spot             "BYBIT:BTCUSDT"
//  BYBITF  Bybit perpetuals       "BYBITF:BTCUSDT"  (shown as BTCUSDT.P)
//  OKX     OKX spot               "OKX:BTC-USDT"
//  OKXF    OKX perpetual swaps    "OKXF:BTC-USDT"   (shown as BTC-USDT.P; OKX's own id is BTC-USDT-SWAP)

import { t } from './i18n.js';
import { basePlan, aggregateUtc, utcBucket } from './timeframes.js';

const NAMES = { BYBIT: 'Bybit', BYBITF: 'Bybit Futures', OKX: 'OKX', OKXF: 'OKX Futures' };

/** Seconds to add to UTC so intraday bars show in the viewer's local time. */
const localOffset = () => -new Date().getTimezoneOffset() * 60;

function decimalsFromTick(tick) {
  const s = String(tick).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** GET a URL from the first host that answers; the exchange's own error message when it refuses. */
async function getFrom(src, hosts, path) {
  let lastErr;
  for (const host of hosts) {
    try {
      const r = await fetch(host + path);
      const body = await r.json().catch(() => null);
      if (r.status === 403 || r.status === 451) throw Object.assign(new Error(t('feed.unreachable', { source: NAMES[src] })), { status: r.status });
      if (!r.ok) throw Object.assign(new Error(body?.retMsg || body?.msg || `HTTP ${r.status}`), { status: r.status });
      // Both answer 200 with an error code in the body for a bad symbol and the like.
      if (body?.retCode != null && body.retCode !== 0) throw Object.assign(new Error(body.retMsg || 'Bybit error'), { status: 400 });
      if (body?.code != null && body.code !== '0') throw Object.assign(new Error(body.msg || 'OKX error'), { status: 400 });
      return body;
    } catch (e) {
      lastErr = e.status ? e : new Error(t('feed.unreachable', { source: NAMES[src] }));
      if (e.status === 400) break; // another host would say the same
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Each exchange's endpoints and shapes
// ---------------------------------------------------------------------------

const BYBIT_REST = ['https://api.bybit.com', 'https://api.bytick.com'];
const BYBIT_WS = ['wss://stream.bybit.com', 'wss://stream.bytick.com'];
const bybitCat = (src) => (src === 'BYBITF' ? 'linear' : 'spot');
const bybitGet = (src, path) => getFrom(src, BYBIT_REST, path);

const OKX_REST = ['https://www.okx.com', 'https://aws.okx.com'];
const OKX_WS = ['wss://ws.okx.com:8443/ws/v5/public', 'wss://wsaws.okx.com:8443/ws/v5/public'];
const okxGet = (src, path) => getFrom(src, OKX_REST, path);
/** OKX's instrument id for one of our tickers: perpetuals end in -SWAP. */
const okxId = (src, ticker) => (src === 'OKXF' ? `${ticker}-SWAP` : ticker);

export const EXCHANGE_SOURCES = {
  BYBIT: { name: NAMES.BYBIT, crypto: true },
  BYBITF: { name: NAMES.BYBITF, crypto: true, suffix: '.P' },
  OKX: { name: NAMES.OKX, crypto: true },
  OKXF: { name: NAMES.OKXF, crypto: true, suffix: '.P' },
};
export const isExchangeSource = (src) => !!EXCHANGE_SOURCES[src];

const row = (time, o, h, l, c, v) => ({ time: Math.floor(Number(time) / 1000), open: +o, high: +h, low: +l, close: +c, volume: +v });

const ADAPTERS = {
  bybit: {
    plan: 'bybit',
    limit: 1000,
    /** Candles ending at endMs (or now), oldest first. */
    async candles(src, ticker, interval, endMs) {
      const body = await bybitGet(src, `/v5/market/kline?category=${bybitCat(src)}&symbol=${ticker}&interval=${interval}&limit=1000${endMs == null ? '' : `&end=${endMs}`}`);
      const list = body.result?.list || [];
      return { rows: list.map((k) => row(k[0], k[1], k[2], k[3], k[4], k[5])).reverse(), more: list.length >= 1000 }; // a short page: the start of its history
    },
    async info(src, ticker) {
      const body = await bybitGet(src, `/v5/market/instruments-info?category=${bybitCat(src)}&symbol=${ticker}`);
      const s = body.result?.list?.[0];
      if (!s) throw Object.assign(new Error(t('feed.noSymbol', { symbol: ticker, source: NAMES[src] })), { status: 404 });
      return { base: s.baseCoin, quote: s.quoteCoin, tick: s.priceFilter?.tickSize || '0.01', size: 1 };
    },
    wsUrl: (src, i) => `${BYBIT_WS[i % BYBIT_WS.length]}/v5/public/${bybitCat(src)}`,
    // Bybit takes up to 10 topics per subscribe message on spot.
    subscribe: (src, topics) => {
      const out = [];
      for (let i = 0; i < topics.length; i += 10) out.push(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }));
      return out;
    },
    tradeTopic: (src, ticker) => `publicTrade.${ticker}`,
    /** Trades in a message: [{ ms, price, size }]. */
    trades(m) {
      if (!m.topic?.startsWith('publicTrade.') || !Array.isArray(m.data)) return [];
      return m.data.map((d) => ({ ms: +d.T, price: +d.p, size: +d.v }));
    },
    tickerTopic: (src, ticker) => `tickers.${ticker}`,
    /** Ticker updates in a message: [{ ticker, last?, open? }] (perpetual updates carry only what changed). */
    tickers(m) {
      if (!m.topic?.startsWith('tickers.') || !m.data) return [];
      const d = m.data;
      return [{ ticker: d.symbol || m.topic.slice(8), last: d.lastPrice != null ? +d.lastPrice : null, open: d.prevPrice24h != null ? +d.prevPrice24h : null }];
    },
    ping: () => JSON.stringify({ op: 'ping' }),
  },
  okx: {
    plan: 'okx',
    limit: 300,
    /**
     * Candles ending before endMs (or now), oldest first. OKX's candles endpoint keeps the last
     * 1,440 bars (300 a page); older ones come from history-candles (100 a page).
     */
    async candles(src, ticker, bar, endMs) {
      const id = okxId(src, ticker);
      const after = endMs == null ? '' : `&after=${endMs + 1}`; // "after": records older than this time
      let body = await okxGet(src, `/api/v5/market/candles?instId=${id}&bar=${bar}&limit=300${after}`);
      let older = false;
      if (!body.data?.length && endMs != null) {
        body = await okxGet(src, `/api/v5/market/history-candles?instId=${id}&bar=${bar}&limit=100${after}`);
        older = true;
      }
      // Volume: spot rows give the coin amount first; perpetual rows give contracts, then the coin amount.
      const vol = (k) => (src === 'OKXF' ? k[6] : k[5]);
      const list = body.data || [];
      // The recent window can end mid-page with older bars still in history-candles; only a short
      // history page is the start.
      return { rows: list.map((k) => row(k[0], k[1], k[2], k[3], k[4], vol(k))).reverse(), more: older ? list.length >= 100 : list.length > 0 };
    },
    async info(src, ticker) {
      const body = await okxGet(src, `/api/v5/public/instruments?instType=${src === 'OKXF' ? 'SWAP' : 'SPOT'}&instId=${okxId(src, ticker)}`);
      const s = body.data?.[0];
      if (!s) throw Object.assign(new Error(t('feed.noSymbol', { symbol: ticker, source: NAMES[src] })), { status: 404 });
      const [base, quote] = ticker.split('-');
      return { base: s.baseCcy || s.ctValCcy || base, quote: s.quoteCcy || s.settleCcy || quote, tick: s.tickSz || '0.01', size: src === 'OKXF' ? +s.ctVal || 1 : 1 };
    },
    wsUrl: (src, i) => OKX_WS[i % OKX_WS.length],
    subscribe: (src, args) => [JSON.stringify({ op: 'subscribe', args })],
    tradeTopic: (src, ticker) => ({ channel: 'trades', instId: okxId(src, ticker) }),
    trades(m) {
      if (m.arg?.channel !== 'trades' || !Array.isArray(m.data)) return [];
      return m.data.map((d) => ({ ms: +d.ts, price: +d.px, size: +d.sz }));
    },
    tickerTopic: (src, ticker) => ({ channel: 'tickers', instId: okxId(src, ticker) }),
    tickers(m) {
      if (m.arg?.channel !== 'tickers' || !Array.isArray(m.data)) return [];
      return m.data.map((d) => ({ ticker: d.instId.replace(/-SWAP$/, ''), last: +d.last, open: +d.open24h }));
    },
    ping: () => 'ping',
  },
};
const adapterOf = (src) => (src === 'BYBIT' || src === 'BYBITF' ? ADAPTERS.bybit : ADAPTERS.okx);

/** Parses a WebSocket message (OKX answers a ping with a bare "pong"). */
const parse = (data) => { try { return JSON.parse(data); } catch { return null; } };

// ---------------------------------------------------------------------------
// Chart feed
// ---------------------------------------------------------------------------

export class ExchangeFeed {
  constructor(src, ticker, tf) {
    this.src = src;
    this.ex = adapterOf(src);
    this.ticker = ticker.toUpperCase();
    this.tf = tf;
    const plan = basePlan(tf, this.ex.plan);
    this.interval = plan.native;
    this.agg = plan.agg;
    this.shift = tf.daily ? 0 : localOffset();
    // About 1,000 bars to start with, more pages for grouped timeframes (10m from 5m).
    this.pages = Math.ceil(1000 / this.ex.limit) * Math.max(1, Math.min(4, plan.factor));
    this.canLoadMore = true;
    this.closed = false;
    this.ws = null;
    this.timer = null;
    this.pingTimer = null;
    this.size = 1; // coins per contract (OKX perpetuals trade in contracts)
    this.bucketOf = tf.daily ? null : (time) => utcBucket(time - this.shift, tf) + this.shift;
  }

  /** `pages` pages of candles ending at endMs (now if null), oldest first, without duplicates. */
  async fetchBack(endMs, pages) {
    let all = [], end = endMs;
    for (let p = 0; p < pages; p++) {
      let page;
      try {
        page = await this.ex.candles(this.src, this.ticker, this.interval, end);
      } catch (e) {
        if (!all.length) throw e;
        break; // keep what came; scrolling back tries again
      }
      all = page.rows.concat(all);
      if (!page.more || !page.rows.length) { this.canLoadMore = false; break; }
      end = page.rows[0].time * 1000 - 1;
    }
    const seen = new Set();
    return all.filter((b) => (seen.has(b.time) ? false : seen.add(b.time)));
  }

  toChart(raw) {
    const bars = this.agg ? aggregateUtc(raw, this.tf) : raw;
    return bars.map((b) => ({ ...b, time: b.time + this.shift }));
  }

  async loadInitial() {
    const [info, raw] = await Promise.all([this.ex.info(this.src, this.ticker), this.fetchBack(null, this.pages)]);
    this.size = info.size;
    const perp = !!EXCHANGE_SOURCES[this.src].suffix;
    return {
      meta: {
        symbol: this.ticker,
        name: perp ? t('feed.perpName', { base: info.base, quote: info.quote }) : `${info.base} / ${info.quote}`,
        exchange: NAMES[this.src],
        currency: info.quote || '',
        type: 'crypto',
        precision: Math.min(decimalsFromTick(info.tick), 8),
        tzOffset: this.shift,
      },
      bars: this.toChart(raw),
    };
  }

  async loadOlder(firstTime) {
    if (!this.canLoadMore) return [];
    const raw = await this.fetchBack((firstTime - this.shift) * 1000 - 1, this.pages);
    return this.toChart(raw).filter((b) => b.time < firstTime);
  }

  /** Every trade moves the price; the official candles are fetched again every 30 s to stay exact. */
  subscribe({ bars, tick, status }) {
    let retry = 0, host = 0;
    const connect = () => {
      if (this.closed) return;
      status('connecting');
      const ws = new WebSocket(this.ex.wsUrl(this.src, host));
      this.ws = ws;
      ws.onopen = () => {
        retry = 0;
        for (const msg of this.ex.subscribe(this.src, [this.ex.tradeTopic(this.src, this.ticker)])) ws.send(msg);
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => { try { ws.send(this.ex.ping()); } catch { /* closing */ } }, 20000);
        status('live');
      };
      ws.onmessage = (ev) => {
        const m = parse(ev.data);
        if (!m) return;
        for (const tr of this.ex.trades(m)) tick({ time: Math.floor(tr.ms / 1000) + this.shift, price: tr.price, volume: tr.size * this.size });
      };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        if (this.closed) return;
        status('reconnecting');
        host++;
        setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const poll = async () => {
      if (this.closed) return;
      try {
        const page = await this.ex.candles(this.src, this.ticker, this.interval, null);
        if (!this.closed) bars(this.toChart(page.rows));
      } catch { /* keep streaming */ }
      if (!this.closed) this.timer = setTimeout(poll, 30000);
    };
    this.timer = setTimeout(poll, 30000);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Whole markets: the Markets panel, symbol search and watchlist snapshots
// ---------------------------------------------------------------------------

const PERP_QUOTES = new Set(['USDT', 'USDC']);

/**
 * Every instrument of one market with its last price, 24h change and 24h turnover (for ranking):
 * [{ ticker, base, quote, price, change, rank }].
 */
export async function exchangeMarket(src) {
  const pct = (last, open) => (open ? ((last - open) / open) * 100 : null);
  if (src === 'BYBIT' || src === 'BYBITF') {
    const cat = bybitCat(src);
    const [inst, tick] = await Promise.all([
      bybitGet(src, `/v5/market/instruments-info?category=${cat}&limit=1000`),
      bybitGet(src, `/v5/market/tickers?category=${cat}`),
    ]);
    const prices = new Map((tick.result?.list || []).map((r) => [r.symbol, r]));
    return (inst.result?.list || [])
      .filter((s) => s.status === 'Trading' && (src === 'BYBIT' || (s.contractType === 'LinearPerpetual' && PERP_QUOTES.has(s.quoteCoin))))
      .map((s) => {
        const r = prices.get(s.symbol) || {};
        const last = +r.lastPrice;
        return {
          ticker: s.symbol, base: s.baseCoin, quote: s.quoteCoin,
          price: Number.isFinite(last) ? last : null, change: pct(last, +r.prevPrice24h), rank: +r.turnover24h || 0,
        };
      });
  }
  const body = await okxGet(src, `/api/v5/market/tickers?instType=${src === 'OKXF' ? 'SWAP' : 'SPOT'}`);
  return (body.data || []).map((r) => {
    const parts = r.instId.split('-');
    if (src === 'OKXF' && (parts[2] !== 'SWAP' || !PERP_QUOTES.has(parts[1]))) return null;
    const last = +r.last;
    // Turnover in the quote currency: spot gives it; a perpetual's volCcy24h is in coins.
    const turnover = src === 'OKXF' ? (+r.volCcy24h || 0) * (last || 0) : +r.volCcy24h || 0;
    return { ticker: `${parts[0]}-${parts[1]}`, base: parts[0], quote: parts[1], price: Number.isFinite(last) ? last : null, change: pct(last, +r.open24h), rank: turnover };
  }).filter(Boolean);
}

const markets = {};
/** The same, kept for 5 minutes: symbol search reads it on every keystroke. */
export function exchangeList(src) {
  const have = markets[src];
  if (have && Date.now() - have.t < 300000) return have.p;
  const p = exchangeMarket(src).catch((e) => { delete markets[src]; throw e; });
  markets[src] = { t: Date.now(), p };
  return p;
}

// ---------------------------------------------------------------------------
// Live quotes for lists (QuoteStream in datafeed.js calls this)
// ---------------------------------------------------------------------------

/**
 * Streams last price and 24h change for some tickers of one market into stream.emit(full, price, open),
 * with a snapshot first. Sockets and timers go on the stream so it can stop them.
 */
export function streamExchangeQuotes(stream, src, tickers, gen) {
  const ex = adapterOf(src);
  const last = new Map(); // ticker -> { last, open }: perpetual updates carry only what changed
  const put = (ticker, upd) => {
    const q = { ...last.get(ticker) };
    if (upd.last != null && Number.isFinite(upd.last)) q.last = upd.last;
    if (upd.open != null && Number.isFinite(upd.open)) q.open = upd.open;
    last.set(ticker, q);
    if (q.last != null && gen === stream.gen) stream.emit(`${src}:${ticker}`, q.last, q.open);
  };
  const wanted = new Set(tickers);
  exchangeList(src).then((rows) => {
    for (const r of rows) {
      if (!wanted.has(r.ticker) || r.price == null) continue;
      const open = r.change != null ? r.price / (1 + r.change / 100) : null;
      if (!last.has(r.ticker)) put(r.ticker, { last: r.price, open });
    }
  }).catch(() => {});
  let host = 0;
  const open = () => {
    if (gen !== stream.gen) return;
    const ws = new WebSocket(ex.wsUrl(src, host));
    stream.sockets.push(ws);
    let ping = null;
    ws.onopen = () => {
      for (const msg of ex.subscribe(src, tickers.map((tk) => ex.tickerTopic(src, tk)))) ws.send(msg);
      ping = setInterval(() => { try { ws.send(ex.ping()); } catch { /* closing */ } }, 20000);
    };
    ws.onmessage = (ev) => {
      const m = parse(ev.data);
      if (m) for (const u of ex.tickers(m)) if (wanted.has(u.ticker)) put(u.ticker, u);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (gen === stream.gen) { host++; stream.timers.push(setTimeout(open, 3000)); }
    };
    ws.onerror = () => ws.close();
  };
  open();
}
