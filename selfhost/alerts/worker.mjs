// The alert worker (PLAN §2.5.1): runs in a worker_threads Worker so that a bad price feed or a
// bug here can never stall the UI or sync. It holds no database: the main thread sends it the
// alerts and the stored progress, and it reports triggers, progress and heartbeats.
//
// main -> worker  { type: 'alerts', items, resume? }  the alerts value (and resume points at start)
//                 { type: 'flush' }                   report progress now (shutdown)
// worker -> main  { type: 'trigger', id, price, at, gap }
//                 { type: 'progress', points: { id: { price, at, session } } }
//                 { type: 'heartbeat', status }       every HEARTBEAT_MS
//                 { type: 'unsupported', symbols }    armed symbols no source serves yet

import { parentPort, workerData } from 'node:worker_threads';
import { createEvaluator } from './evaluate.mjs';
import { createYahooSource, yahooTicker } from './sources/yahoo.mjs';

const HEARTBEAT_MS = 5_000;
const PROGRESS_MS = 5_000;

const { baseUrl, token, extendedHours = true, resumeMaxGapMs = 15 * 60_000, maxSymbols = 200 } = workerData || {};
const send = (msg) => { try { parentPort.postMessage(msg); } catch { /* the main thread is gone */ } };
const logger = (level) => (msg, data) => send({ type: 'log', level, msg, data });
const log = { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') };

const evaluator = createEvaluator({ extendedHours, resumeMaxGapMs });
let dirty = false;
let truncated = 0;
let unsupported = [];

const yahoo = createYahooSource({
  baseUrl,
  headers: { 'x-wickline-internal': token },
  log,
  onTick(t) {
    try {
      for (const f of evaluator.tick(t)) send({ type: 'trigger', ...f });
      dirty = true;
    } catch (e) {
      log.error('alert evaluation failed', { error: e?.message });
    }
  },
});

function applyAlerts(items, resume) {
  evaluator.setAlerts(items, { resume, now: Date.now() });
  const all = evaluator.symbols();
  const tickers = [];
  const other = [];
  for (const s of all) { const t = yahooTicker(s); if (t) tickers.push(t); else other.push(s); }
  truncated = Math.max(0, tickers.length - maxSymbols);
  if (truncated) log.warn('too many symbols with armed alerts; some are not watched', { watched: maxSymbols, skipped: truncated });
  yahoo.setSymbols(tickers.slice(0, maxSymbols));
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
    else if (msg?.type === 'flush') { flushProgress(true); send({ type: 'flushed' }); }
  } catch (e) {
    log.error('alert worker message failed', { error: e?.message });
  }
});

setInterval(() => flushProgress(), PROGRESS_MS).unref();
setInterval(() => send({ type: 'heartbeat', status: { ...yahoo.status(), alerts: evaluator.size, truncated, unsupported: unsupported.length } }), HEARTBEAT_MS);
send({ type: 'heartbeat', status: { ...yahoo.status(), alerts: 0, truncated: 0, unsupported: 0 } });
