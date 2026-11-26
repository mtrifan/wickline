// Runs the alert worker (PLAN §2.5.1) and connects it to the database: sends it the alerts (and,
// at each start, the stored resume points), turns its triggers into ledger.trigger() calls, stores
// its progress, and restarts it with backoff when it exits or stops sending heartbeats.

import { Worker } from 'node:worker_threads';
import { parseIdArray } from '../sync/merge.mjs';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MIN_RESTART_MS = 1_000;
const MAX_RESTART_MS = 60_000;
const STABLE_MS = 60_000; // a worker that ran this long resets the backoff
const FLUSH_TIMEOUT_MS = 2_000;

export function createAlertSupervisor({ ledger, sync, workerData, log, workerUrl = WORKER_URL, now = Date.now, heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS }) {
  let worker = null;
  let stopped = true;
  let restarts = 0;
  let backoff = MIN_RESTART_MS;
  let startedAt = 0;
  let lastHeartbeat = 0;
  let lastStatus = null;
  let lastError = null;
  let unsupported = [];
  let restartTimer = null;
  let watchdog = null;
  let unsubscribe = null;
  let flushed = null;

  const currentAlerts = () => {
    const k = sync.snapshot().keys.alerts;
    return parseIdArray(k && !k.deleted ? k.v : null) || [];
  };

  function onMessage(msg) {
    try {
      switch (msg?.type) {
        case 'heartbeat': lastHeartbeat = now(); lastStatus = msg.status; break;
        case 'trigger': {
          let r;
          try {
            r = ledger.trigger({ id: msg.id, triggerPrice: msg.price, triggeredAt: msg.at, gap: !!msg.gap });
          } catch (e) {
            // The worker already counts the alert as fired: give it the stored list back, so the
            // alert stays armed there and the next crossing fires it.
            log?.error('recording a server trigger failed', { id: msg.id, error: e });
            worker?.postMessage({ type: 'alerts', items: currentAlerts() });
            break;
          }
          if (!r.fired) log?.debug('server trigger already recorded', { id: msg.id });
          break;
        }
        case 'progress': ledger.saveProgress(msg.points); break;
        case 'flushed': flushed?.(); break;
        case 'unsupported':
          unsupported = msg.symbols;
          if (unsupported.length) log?.info('some alert symbols are checked only in the browser for now', { symbols: unsupported.slice(0, 20) });
          break;
        case 'log': log?.[msg.level]?.(msg.msg, msg.data); break;
        default: break;
      }
    } catch (e) {
      log?.error('alert worker message failed', { type: msg?.type, error: e });
    }
  }

  function spawn() {
    if (stopped) return;
    startedAt = now();
    lastHeartbeat = now();
    const w = new Worker(workerUrl, { workerData });
    worker = w;
    w.on('message', onMessage);
    w.on('error', (e) => { lastError = e?.message || String(e); log?.error('alert worker crashed', { error: e }); });
    w.on('exit', (code) => {
      if (worker !== w) return;
      worker = null;
      if (stopped) return;
      lastError ||= `exited with code ${code}`;
      scheduleRestart();
    });
    w.postMessage({ type: 'alerts', items: currentAlerts(), resume: ledger.resumePoints() });
  }

  function scheduleRestart() {
    if (stopped) return;
    if (now() - startedAt > STABLE_MS) backoff = MIN_RESTART_MS;
    restarts++;
    log?.warn('restarting the alert worker', { inSec: Math.round(backoff / 1000), restarts });
    clearTimeout(restartTimer);
    restartTimer = setTimeout(spawn, backoff);
    restartTimer.unref?.();
    backoff = Math.min(MAX_RESTART_MS, backoff * 2);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    unsubscribe = sync.onChange((c) => {
      if (c.key !== 'alerts' || !worker) return;
      worker.postMessage({ type: 'alerts', items: c.deleted ? [] : parseIdArray(c.v) || [] });
    });
    // A worker that stops sending heartbeats is stuck (a busy loop): replace it.
    watchdog = setInterval(() => {
      if (worker && now() - lastHeartbeat > heartbeatTimeoutMs) {
        lastError = 'no heartbeat';
        log?.error('the alert worker stopped responding; restarting it');
        const w = worker;
        worker = null;
        w.terminate().catch(() => {});
        scheduleRestart();
      }
    }, Math.min(heartbeatTimeoutMs, 10_000));
    watchdog.unref?.();
    spawn();
  }

  /** Stops the worker after asking it for its latest progress (at most FLUSH_TIMEOUT_MS). */
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    clearInterval(watchdog);
    unsubscribe?.();
    const w = worker;
    worker = null;
    if (!w) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      flushed = () => { clearTimeout(t); resolve(); };
      try { w.postMessage({ type: 'flush' }); } catch { resolve(); }
    });
    flushed = null;
    await w.terminate().catch(() => {});
  }

  function status() {
    const t = now();
    return {
      running: !!worker && t - lastHeartbeat <= heartbeatTimeoutMs,
      restarts,
      lastError,
      lastHeartbeatAgoSec: worker ? Math.round((t - lastHeartbeat) / 1000) : null,
      ...(lastStatus || {}),
      unsupportedSymbols: unsupported,
    };
  }

  return { start, stop, status, get worker() { return worker; } };
}
