// Crypto prices for the alert worker (PLAN §2.5.2): Binance spot and USDⓈ-M futures (@miniTicker
// combined streams) and Coinbase (ticker channel), with their REST tickers for the fallback.
// Hosts, endpoints and message fields mirror upstream's public/js/datafeed.js; a contract test keeps
// them in step (integration point crypto-feeds).

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
    return new Map(rows.filter((r) => want.has(r?.symbol) && Number.isFinite(Number(r.lastPrice))).map((r) => [r.symbol, Number(r.lastPrice)]));
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
      if (Number.isFinite(Number(s?.last))) out.set(t, Number(s.last));
    });
    return out;
  }
  return { fetchPrices: (market, tickers) => (market === 'COINBASE' ? coinbase(tickers) : binance(market, tickers)) };
}
