// Crypto prices for the alert worker (PLAN §2.5.2): Binance spot and USDⓈ-M futures (@miniTicker
// combined streams), Coinbase (ticker channel), Bybit and OKX spot and perpetuals (tickers channels),
// with their REST tickers for the fallback. Hosts, endpoints and message fields mirror upstream's
// public/js/datafeed.js and public/js/crypto-exchanges.js; a contract test keeps them in step
// (integration point crypto-feeds).

import { keepOpen } from './socket.mjs';
import { assignShards } from './shards.mjs';

export const BINANCE = {
  BINANCE: {
    rest: ['https://data-api.binance.vision', 'https://api.binance.com'],
    ws: ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'],
    wsPath: '/stream',
    ticker24: '/api/v3/ticker/24hr',
  },
  BINANCEF: {
    rest: ['https://fapi.binance.com'],
    ws: ['wss://fstream.binance.com'],
    // Deliberately not upstream's '/stream': Binance moved USDⓈ-M market streams to '/market/stream'
    // (checked 2026-11-26: '/stream' still accepts the connection but sends nothing).
    wsPath: '/market/stream',
    ticker24: '/fapi/v1/ticker/24hr',
  },
};
export const COINBASE_REST = 'https://api.exchange.coinbase.com';
export const COINBASE_WS = 'wss://ws-feed.exchange.coinbase.com';

// Bybit and OKX (upstream 0.1.10, crypto-exchanges.js). Perpetuals: Bybit's "linear" category, and
// OKX instrument ids ending in -SWAP; the app's tickers have no suffix (BTCUSDT, BTC-USDT).
export const BYBIT_REST = ['https://api.bybit.com', 'https://api.bytick.com'];
export const BYBIT_WS = ['wss://stream.bybit.com', 'wss://stream.bytick.com'];
export const OKX_REST = ['https://www.okx.com', 'https://aws.okx.com'];
export const OKX_WS = ['wss://ws.okx.com:8443/ws/v5/public', 'wss://wsaws.okx.com:8443/ws/v5/public'];
// Tried first: OKX announced the end of port 8443 for public connections (upstream still uses it;
// both work as of 2026-11-26). The port-less host keeps streaming either way.
const OKX_WS_HOSTS = ['wss://ws.okx.com/ws/v5/public', ...OKX_WS];
export const bybitCategory = (market) => (market === 'BYBITF' ? 'linear' : 'spot');
export const okxId = (market, ticker) => (market === 'OKXF' ? `${ticker}-SWAP` : ticker);
const EXCHANGE_PING_MS = 20_000; // both drop a connection that sends nothing for 30 s
// Pongs keep a connection "alive" even if its subscription stalled: with no price at all for this
// long, it is reopened (and resubscribed). Long enough for quiet pairs not to churn.
const PRICE_SILENCE_MS = 5 * 60_000;

/**
 * A price from an exchange field: a positive finite number, or NaN. Number('') and Number(null) are
 * 0, which would read as a crash to zero and fire alerts; crypto prices are never zero or negative.
 */
export function toPrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : NaN;
  if (typeof v !== 'string' || !/^\s*\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v)) return NaN;
  const n = Number(v);
  return n > 0 ? n : NaN;
}

/** Streams per Binance connection (Binance allows 1024 on spot, 200 on futures). */
const BINANCE_PER_CONN = 200;

/**
 * A source over sharded connections: setSymbols(tickers) keeps unchanged shards connected.
 * makeShard(tickers) -> { close(), connected }.
 */
function sharded(makeShard, perConn, onState) {
  let shards = [];
  return {
    setSymbols(tickers) {
      const groups = assignShards(shards.map((s) => s.tickers), tickers, perConn);
      const byGroup = new Map(shards.map((s) => [s.tickers, s]));
      const next = groups.map((g) => byGroup.get(g) ?? { tickers: g, conn: makeShard(g) });
      const kept = new Set(next);
      for (const s of shards) if (!kept.has(s)) s.conn.close();
      shards = next;
      onState();
    },
    close() { for (const s of shards) s.conn.close(); shards = []; },
    status() {
      return { streams: shards.length, connected: shards.filter((s) => s.conn.connected).length, symbols: shards.reduce((n, s) => n + s.tickers.length, 0) };
    },
  };
}

/**
 * Binance spot ('BINANCE') or futures ('BINANCEF'): onTick({ symbol: 'BINANCE:BTCUSDT', price, session, at }).
 */
export function createBinanceSource({ market, openWs, onTick, onState = () => {}, log, perConn = BINANCE_PER_CONN }) {
  const cfg = BINANCE[market];
  return sharded((tickers) => {
    const streams = tickers.map((t) => `${t.toLowerCase()}@miniTicker`).join('/');
    return keepOpen({
      name: `${market} stream`,
      urls: () => cfg.ws.map((h) => `${h}${cfg.wsPath}?streams=${streams}`),
      openWs,
      log,
      onState,
      onMessage(text) {
        const d = JSON.parse(text).data;
        const price = toPrice(d?.c);
        if (d && typeof d.s === 'string' && Number.isFinite(price)) onTick({ symbol: `${market}:${d.s}`, price, session: 1, at: Date.now() });
      },
    });
  }, perConn, onState);
}

/** Coinbase: one connection; the heartbeat channel keeps quiet products from looking dead. */
export function createCoinbaseSource({ openWs, onTick, onState = () => {}, log, perConn = 100 }) {
  return sharded((tickers) => keepOpen({
    name: 'Coinbase stream',
    urls: () => [COINBASE_WS],
    openWs,
    log,
    onState,
    silenceMs: 60_000,
    onOpen(ws) { ws.send(JSON.stringify({ type: 'subscribe', product_ids: tickers, channels: ['ticker', 'heartbeat'] })); },
    onMessage(text) {
      const m = JSON.parse(text);
      const price = toPrice(m.price);
      if (m.type === 'ticker' && typeof m.product_id === 'string' && Number.isFinite(price)) onTick({ symbol: `COINBASE:${m.product_id}`, price, session: 1, at: Date.now() });
      else if (m.type === 'error') log?.warn?.('Coinbase refused the subscription', { message: m.message, reason: m.reason });
    },
  }), perConn, onState);
}

/** Bybit spot ('BYBIT') or perpetuals ('BYBITF'): the tickers.<SYMBOL> topics, 10 per subscribe message. */
export function createBybitSource({ market, openWs, onTick, onState = () => {}, log, perConn = 100 }) {
  const cat = bybitCategory(market);
  return sharded((tickers) => keepOpen({
    name: `${market} stream`,
    urls: () => BYBIT_WS.map((h) => `${h}/v5/public/${cat}`),
    openWs,
    log,
    onState,
    silenceMs: 60_000,
    priceSilenceMs: PRICE_SILENCE_MS,
    ping: { everyMs: EXCHANGE_PING_MS, message: () => JSON.stringify({ op: 'ping' }) },
    onOpen(ws) {
      const topics = tickers.map((t) => `tickers.${t}`);
      for (let i = 0; i < topics.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }));
    },
    onMessage(text) {
      const m = JSON.parse(text);
      if (!m.topic?.startsWith('tickers.') || !m.data) return false;
      // Perpetual updates carry only the fields that changed: no lastPrice means no new price.
      const price = toPrice(m.data.lastPrice);
      const ticker = m.data.symbol || m.topic.slice(8);
      if (!Number.isFinite(price)) return false;
      onTick({ symbol: `${market}:${ticker}`, price, session: 1, at: Date.now() });
      return true;
    },
  }), perConn, onState);
}

/** OKX spot ('OKX') or perpetuals ('OKXF'): the tickers channel. OKX answers "ping" with a bare "pong". */
export function createOkxSource({ market, openWs, onTick, onState = () => {}, log, perConn = 100 }) {
  return sharded((tickers) => keepOpen({
    name: `${market} stream`,
    urls: () => OKX_WS_HOSTS,
    openWs,
    log,
    onState,
    silenceMs: 60_000,
    priceSilenceMs: PRICE_SILENCE_MS,
    ping: { everyMs: EXCHANGE_PING_MS, message: () => 'ping' },
    onOpen(ws) { ws.send(JSON.stringify({ op: 'subscribe', args: tickers.map((t) => ({ channel: 'tickers', instId: okxId(market, t) })) })); },
    onMessage(text) {
      if (text === 'pong') return false;
      const m = JSON.parse(text);
      if (m.event === 'error') { log?.warn?.('OKX refused the subscription', { code: m.code, message: m.msg }); return false; }
      if (m.arg?.channel !== 'tickers' || !Array.isArray(m.data)) return false;
      let any = false;
      for (const d of m.data) {
        const price = toPrice(d.last);
        if (typeof d.instId !== 'string' || !Number.isFinite(price)) continue;
        onTick({ symbol: `${market}:${d.instId.replace(/-SWAP$/, '')}`, price, session: 1, at: Date.now() });
        any = true;
      }
      return any;
    },
  }), perConn, onState);
}

/** A REST failure that tells how long to wait (429/418 with Retry-After). */
export class RateLimited extends Error {
  constructor(status, waitMs) { super(`rate limited (${status})`); this.status = status; this.waitMs = waitMs; }
}

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 429 || r.status === 418) {
    const after = Number(r.headers.get('retry-after'));
    throw new RateLimited(r.status, after > 0 ? after * 1000 : r.status === 418 ? 120_000 : 30_000);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Latest prices from REST, per market: fetchPrices(market, tickers) -> Map(ticker -> price).
 * Uses the same 24-hour ticker endpoints as upstream; Binance hosts are tried in turn.
 */
/**
 * Runs fn over items, at most `limit` at a time. One failing item is tolerated; a RateLimited
 * failure stops the rest and is thrown, and so is the last error when every item failed (an outage,
 * which the caller reports and backs off from, rather than "no price").
 */
async function eachLimited(items, limit, fn) {
  let i = 0;
  let limited = null;
  let failed = 0;
  let lastError = null;
  const run = async () => {
    while (i < items.length && !limited) {
      const item = items[i++];
      try { await fn(item); } catch (e) { if (e instanceof RateLimited) limited = e; else { failed++; lastError = e; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (limited) throw limited;
  if (items.length && failed === items.length) throw lastError;
}

export function createCryptoRest({ fetch: fetchFn, concurrency = 4 }) {
  const hostIndex = { BINANCE: 0, BINANCEF: 0 }; // the host that answered last is tried first

  async function binanceGet(market, path) {
    const hosts = BINANCE[market].rest;
    let last;
    for (let k = 0; k < hosts.length; k++) {
      const idx = (hostIndex[market] + k) % hosts.length;
      try {
        const body = await getJson(fetchFn, hosts[idx] + path);
        hostIndex[market] = idx;
        return body;
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        last = e;
      }
    }
    throw last;
  }

  const rowsToMap = (rows, tickers) => {
    const want = new Set(tickers);
    return new Map(rows.filter((r) => want.has(r?.symbol) && Number.isFinite(toPrice(r.lastPrice))).map((r) => [r.symbol, toPrice(r.lastPrice)]));
  };

  async function binance(market, tickers) {
    const cfg = BINANCE[market];
    if (market === 'BINANCE') {
      const body = await binanceGet(market, `${cfg.ticker24}?type=MINI&symbols=${encodeURIComponent(JSON.stringify(tickers))}`);
      return rowsToMap(Array.isArray(body) ? body : [], tickers);
    }
    // Futures has no batch by symbol list: one light request per symbol, like upstream.
    const out = new Map();
    await eachLimited(tickers, concurrency, async (t) => {
      const body = await binanceGet(market, `${cfg.ticker24}?symbol=${encodeURIComponent(t)}`);
      for (const [k, v] of rowsToMap([body], [t])) out.set(k, v);
    });
    return out;
  }

  async function coinbase(tickers) {
    const out = new Map();
    await eachLimited(tickers, concurrency, async (t) => {
      const s = await getJson(fetchFn, `${COINBASE_REST}/products/${encodeURIComponent(t)}/stats`);
      const price = toPrice(s?.last);
      if (Number.isFinite(price)) out.set(t, price);
    });
    return out;
  }
  /**
   * The first host that answers; an exchange-level error (retCode / code not 0) counts as a failure,
   * and an exchange's own "too many requests" answer backs off like HTTP 429 (Bybit 10006 / 10018,
   * OKX 50011).
   */
  async function fromHosts(hosts, path, ok) {
    let last;
    for (const host of hosts) {
      try {
        const body = await getJson(fetchFn, host + path);
        if ([10006, 10018].includes(body?.retCode) || body?.code === '50011') throw new RateLimited(429, 30_000);
        if (!ok(body)) throw new Error(`exchange error: ${String(body?.retMsg ?? body?.msg ?? 'unknown').slice(0, 100)}`);
        return body;
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        last = e;
      }
    }
    throw last;
  }

  async function bybit(market, tickers) {
    const out = new Map();
    await eachLimited(tickers, concurrency, async (t) => {
      const body = await fromHosts(BYBIT_REST, `/v5/market/tickers?category=${bybitCategory(market)}&symbol=${encodeURIComponent(t)}`, (b) => b?.retCode === 0);
      const price = toPrice(body.result?.list?.[0]?.lastPrice);
      if (Number.isFinite(price)) out.set(t, price);
    });
    return out;
  }

  /** One request per market, as upstream lists them: every ticker of SPOT or SWAP, filtered here. */
  async function okx(market, tickers) {
    const body = await fromHosts(OKX_REST, `/api/v5/market/tickers?instType=${market === 'OKXF' ? 'SWAP' : 'SPOT'}`, (b) => b?.code === '0');
    const ids = new Map(tickers.map((t) => [okxId(market, t), t]));
    const out = new Map();
    for (const r of Array.isArray(body.data) ? body.data : []) {
      const t = ids.get(r?.instId);
      const price = toPrice(r?.last);
      if (t && Number.isFinite(price)) out.set(t, price);
    }
    return out;
  }

  return {
    fetchPrices(market, tickers) {
      if (market === 'COINBASE') return coinbase(tickers);
      if (market === 'BYBIT' || market === 'BYBITF') return bybit(market, tickers);
      if (market === 'OKX' || market === 'OKXF') return okx(market, tickers);
      return binance(market, tickers);
    },
  };
}
