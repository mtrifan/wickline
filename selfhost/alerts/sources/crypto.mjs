// Crypto prices for the alert worker (PLAN §2.5.2): Binance spot and USDⓈ-M futures (@miniTicker
// combined streams) and Coinbase (ticker channel), with their REST tickers for the fallback.
// Hosts, endpoints and message fields mirror upstream's public/js/datafeed.js; a contract test keeps
// them in step (integration point crypto-feeds).

import { keepOpen } from './socket.mjs';

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
      const want = [...new Set(tickers)].sort();
      const groups = [];
      for (let i = 0; i < want.length; i += perConn) groups.push(want.slice(i, i + perConn));
      const keep = new Map(shards.map((s) => [s.key, s]));
      const next = [];
      for (const g of groups) {
        const key = g.join(',');
        if (keep.has(key)) { next.push(keep.get(key)); keep.delete(key); } else next.push({ key, tickers: g, conn: makeShard(g) });
      }
      for (const s of keep.values()) s.conn.close();
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
        const price = Number(d?.c);
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
      const price = Number(m.price);
      if (m.type === 'ticker' && typeof m.product_id === 'string' && Number.isFinite(price)) onTick({ symbol: `COINBASE:${m.product_id}`, price, session: 1, at: Date.now() });
      else if (m.type === 'error') log?.warn?.('Coinbase refused the subscription', { message: m.message, reason: m.reason });
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
export function createCryptoRest({ fetch: fetchFn }) {
  async function binance(market, tickers) {
    const cfg = BINANCE[market];
    const path = market === 'BINANCE'
      ? `${cfg.ticker24}?type=MINI&symbols=${encodeURIComponent(JSON.stringify(tickers))}`
      : tickers.length === 1 ? `${cfg.ticker24}?symbol=${encodeURIComponent(tickers[0])}` : cfg.ticker24;
    let last;
    for (const host of cfg.rest) {
      try {
        const body = await getJson(fetchFn, host + path);
        const rows = Array.isArray(body) ? body : [body];
        const want = new Set(tickers);
        return new Map(rows.filter((r) => want.has(r?.symbol) && Number.isFinite(Number(r.lastPrice))).map((r) => [r.symbol, Number(r.lastPrice)]));
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        last = e;
      }
    }
    throw last;
  }
  async function coinbase(tickers) {
    const out = new Map();
    for (const t of tickers) {
      const s = await getJson(fetchFn, `${COINBASE_REST}/products/${encodeURIComponent(t)}/stats`);
      if (Number.isFinite(Number(s?.last))) out.set(t, Number(s.last));
    }
    return out;
  }
  return { fetchPrices: (market, tickers) => (market === 'COINBASE' ? coinbase(tickers) : binance(market, tickers)) };
}
