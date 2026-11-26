// The alert worker (PLAN §2.5.1): runs in a worker_threads Worker so that a bad price feed or a
// bug here can never stall the UI or sync. It holds no database: the main thread sends it the
// alerts and the stored progress, and it reports triggers, progress and heartbeats.
//
// main -> worker  { type: 'alerts', items, resume? }  the alerts value (and resume points at start)
//                 { type: 'paperSymbols', symbols }   symbols the paper account needs (watched first)
//                 { type: 'flush' }                   report progress now (shutdown)
// worker -> main  { type: 'trigger', id, price, at, gap }
//                 { type: 'progress', points: { id: { price, at, session } } }
//                 { type: 'stale', symbol, since }    a symbol's prices stopped while its market is open
//                 { type: 'heartbeat', status }       every HEARTBEAT_MS
//                 { type: 'unsupported', symbols }    armed symbols no source serves
//                 { type: 'price', symbol, price, at } a streamed price for a paper symbol (account's name)

import { parentPort, workerData } from 'node:worker_threads';
import { createEvaluator, normalizeSymbol } from './evaluate.mjs';
import { createFeeds, route, chartOpen } from './feeds.mjs';
import { createNet } from './net.mjs';
import { createYahooSource } from './sources/yahoo.mjs';
import { createBinanceSource, createCoinbaseSource, createBybitSource, createOkxSource, createCryptoRest } from './sources/crypto.mjs';

const HEARTBEAT_MS = 5_000;
const PROGRESS_MS = 5_000;
const STEP_MS = 5_000;
const MIN = 60_000;

const {
  baseUrl, token, proxyUrl = null, extendedHours = true, resumeMaxGapMs = 15 * MIN, maxSymbols = 200,
  pollMs = 30_000, closedPollMs = 15 * MIN, staleAfter = { crypto: 5 * MIN, equity: 10 * MIN },
} = workerData || {};
const send = (msg) => { try { parentPort.postMessage(msg); } catch { /* the main thread is gone */ } };
const logger = (level) => (msg, data) => send({ type: 'log', level, msg, data });
const log = { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') };

const net = createNet({ proxyUrl });
const internal = { 'x-wickline-internal': token };
const evaluator = createEvaluator({ extendedHours, resumeMaxGapMs });
const cryptoRest = createCryptoRest({ fetch: net.fetch });
let dirty = false;
let truncated = 0;
let unsupported = [];
let paperBySymbol = new Map(); // normalized symbol -> the account's own symbol names

async function loopbackJson(path) {
  const r = await net.loopback(`${baseUrl}${path}`, { headers: internal, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
  return r.json();
}

const rest = {
  async prices(market, tickers) {
    if (market !== 'YAHOO') return cryptoRest.fetchPrices(market, tickers);
    const rows = await loopbackJson(`/api/yahoo/quotes?symbols=${tickers.map(encodeURIComponent).join(',')}`);
    return new Map((Array.isArray(rows) ? rows : []).filter((q) => Number.isFinite(q?.price)).map((q) => [q.symbol, q.price]));
  },
  /** Open when the 1-minute chart has a bar from the last 15 minutes (holidays and half days included). */
  async marketOpen(ticker) {
    return chartOpen(await loopbackJson(`/api/yahoo/chart?symbol=${encodeURIComponent(ticker)}&tf=1m&live=1&prepost=${extendedHours ? 1 : 0}`));
  },
};

function onPrice(t) {
  try {
    for (const f of evaluator.tick(t)) send({ type: 'trigger', ...f });
    dirty = true;
  } catch (e) {
    log.error('alert evaluation failed', { error: e?.message });
  }
  // Paper fills use streamed prices only (REST fallback prices can be delayed).
  if (t.source === 'stream') {
    for (const name of paperBySymbol.get(normalizeSymbol(t.symbol)) ?? []) send({ type: 'price', symbol: name, price: t.price, at: t.at });
  }
}

const feeds = createFeeds({
  sources: {
    YAHOO: createYahooSource({ baseUrl, headers: internal, fetch: net.loopback, log, onTick: (t) => feeds.tick(t) }),
    BINANCE: createBinanceSource({ market: 'BINANCE', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    BINANCEF: createBinanceSource({ market: 'BINANCEF', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    COINBASE: createCoinbaseSource({ openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    BYBIT: createBybitSource({ market: 'BYBIT', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    BYBITF: createBybitSource({ market: 'BYBITF', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    OKX: createOkxSource({ market: 'OKX', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
    OKXF: createOkxSource({ market: 'OKXF', openWs: net.openWs, log, onTick: (t) => feeds.tick(t) }),
  },
  rest,
  onPrice,
  onStale: (symbol, since) => send({ type: 'stale', symbol, since }),
  pollMs,
  closedPollMs,
  staleAfter,
  log,
});

function applyAlerts(items, resume) {
  evaluator.setAlerts(items, { resume, now: Date.now() });
  watch();
}

/** Paper symbols first (a stop protects money), then alert symbols, under ALERT_MAX_SYMBOLS. */
function watch() {
  const all = [...new Set([...paperBySymbol.keys(), ...evaluator.symbols()])];
  const supported = all.filter((s) => route(s));
  const other = all.filter((s) => !route(s));
  truncated = Math.max(0, supported.length - maxSymbols);
  if (truncated) log.warn('too many symbols with armed alerts; some are not watched', { watched: maxSymbols, skipped: truncated });
  feeds.setSymbols(supported.slice(0, maxSymbols));
  if (other.join() !== unsupported.join()) {
    unsupported = other;
    send({ type: 'unsupported', symbols: other });
  }
}

function flushProgress(force = false) {
  if (!dirty && !force) return;
  dirty = false;
  send({ type: 'progress', points: evaluator.progress() });
}

parentPort.on('message', (msg) => {
  try {
    if (msg?.type === 'alerts') applyAlerts(msg.items, msg.resume);
    else if (msg?.type === 'paperSymbols') {
      paperBySymbol = new Map();
      for (const s of Array.isArray(msg.symbols) ? msg.symbols : []) {
        const k = normalizeSymbol(s);
        paperBySymbol.set(k, [...(paperBySymbol.get(k) ?? []), s]);
      }
      watch();
    }
    else if (msg?.type === 'flush') { flushProgress(true); send({ type: 'flushed' }); }
  } catch (e) {
    log.error('alert worker message failed', { error: e?.message });
  }
});

const heartbeat = () => send({ type: 'heartbeat', status: { alerts: evaluator.size, truncated, unsupported: unsupported.length, ...feeds.status() } });
setInterval(() => { try { feeds.step(); } catch (e) { log.error('feed schedule failed', { error: e?.message }); } }, STEP_MS).unref();
setInterval(() => flushProgress(), PROGRESS_MS).unref();
setInterval(heartbeat, HEARTBEAT_MS);
heartbeat();
