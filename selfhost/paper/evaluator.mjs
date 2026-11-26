// The server's paper-trading evaluator (selfhost/docs/PHASE5-PAPER.md): while no main window is open
// (presence.mjs), it owns the live paper account and runs upstream's own engine (PaperAccount) on
// streamed prices, so limits, stops, stop losses and take profits fill while you are away.
// Best effort by design (§8): upstream's browser engine cannot be fenced from the fork.
//
// One account in memory (coherent marks for buying power), one price at a time, and every result
// committed with its notifications in one SQLite transaction, as a compare-and-swap on the epoch and
// version it loaded. Anything else that changes the account (a browser, an import, a restore) makes
// it reload and starts a new generation: prices received before that are dropped.

import { PaperAccount } from '../../public/js/paper.js';

export const BY = 'server-paper'; // updated_by of the evaluator's own commits
export const FRESH_MS = 10_000; // a price must reach the evaluator this soon after it arrived

const TICKER = (symbol) => String(symbol).slice(String(symbol).indexOf(':') + 1) || String(symbol);
const num = (v) => (Number.isFinite(v) ? Number(v.toPrecision(10)).toString() : String(v));

/** The push for one result: a fill or a rejection (upstream's reasons: Market, Limit, Stop, Stop loss…). */
export function paperPayload(r, publicUrl) {
  const url = publicUrl ? { url: `${publicUrl}/#s=${encodeURIComponent(r.symbol)}` } : {};
  if (r.rejected) {
    const type = r.order?.type || 'order';
    return { title: `${TICKER(r.symbol)} ${type} order rejected`, message: `${r.reason || 'Rejected'} · Paper`, ...url };
  }
  const side = r.side === 'sell' ? 'Sell' : 'Buy';
  return { title: `${TICKER(r.symbol)} ${String(r.reason || 'Order').toLowerCase()} filled at ${num(r.price)}`, message: `${side} ${num(r.qty)} · Paper`, ...url };
}

/**
 * createPaperEvaluator({ sync, db, outbox, presence, publicUrl, notify, log, now })
 *   sync      the synced state (get, mutate, epoch, onChange, onEpoch)
 *   outbox    for notifications (insert inside the transaction, kick after)
 * Call tick() every few seconds (ownership changes), handover() before serving a main window's page,
 * and price({ symbol, price, at }) for every streamed price of a watched symbol.
 */
export function createPaperEvaluator({ sync, db, outbox, presence, publicUrl = null, notify = true, log, now = Date.now, freshMs = FRESH_MS }) {
  let owner = false;
  let account = null; // PaperAccount while the server owns it
  let held = null; // { epoch, version } the account was loaded at
  let generationAt = 0; // prices received before this are dropped
  let marksMoved = false; // prices moved `last` since the last save
  let paused = null; // why the evaluator stopped (a repeated storage failure, a quota error)
  let lastResult = null;
  const listeners = new Set();

  function load() {
    const cur = sync.get('paper');
    let saved = null;
    try { saved = cur.value ? JSON.parse(cur.value) : null; } catch { saved = null; }
    account = new PaperAccount({}, saved);
    held = { epoch: sync.epoch(), version: cur.version };
    generationAt = now();
    marksMoved = false;
    emit();
  }

  /** Symbols the account needs prices for (an order, or a position that may carry a stop or target). */
  function symbols() {
    const acc = account ?? (() => { const c = sync.get('paper'); try { return new PaperAccount({}, c.value ? JSON.parse(c.value) : null); } catch { return new PaperAccount(); } })();
    return [...new Set([...Object.keys(acc.positions), ...acc.orders.map((o) => o.symbol)])].filter((s) => acc.hasWork(s));
  }

  function emit() { for (const fn of listeners) { try { fn(symbols()); } catch (e) { log?.error('paper listener failed', { error: e }); } } }

  /**
   * Writes the account if the stored one is still the version it loaded (same epoch); queues the
   * results' notifications in the same transaction. Returns 'ok', 'conflict' or throws (storage).
   */
  function commit(results) {
    let outcome = 'conflict';
    let queued = false;
    sync.mutate('paper', (cur, { version }) => {
      if (sync.epoch() !== held.epoch || version - 1 !== held.version) return undefined; // replaced underneath
      if (notify && outbox) {
        results.forEach((r, n) => {
          if (outbox.insert(`paper:${held.epoch}:${version}:${n}`, paperPayload(r, publicUrl))) queued = true;
        });
      }
      outcome = 'ok';
      held = { epoch: held.epoch, version };
      return JSON.stringify(account.toJSON());
    }, { by: BY });
    if (queued) outbox.kick();
    return outcome;
  }

  function apply(symbol, price, atMs, replay = true) {
    // A price for a symbol with work may fill: keep the account as it was (all marks included), so a
    // failed save can be retried from exactly this state rather than from older stored marks.
    const before = account.hasWork(symbol) ? new PaperAccount({}, account.toJSON()) : null;
    const results = account.tick(symbol, price, Math.floor(atMs / 1000));
    if (!results.length) { marksMoved = true; return; }
    let outcome;
    try {
      outcome = commit(results);
    } catch (e) {
      // A storage failure, not a conflict. If the stored account is still the one we hold, retry
      // this price once from the state before it (same generation: queued prices stay valid);
      // if it changed, it is an outside change: reload.
      log?.error('paper commit failed', { error: e });
      const cur = sync.get('paper');
      if (sync.epoch() === held.epoch && cur.version === held.version) account = before;
      else { load(); return; }
      if (replay) { apply(symbol, price, atMs, false); return; }
      paused = `storage error: ${e?.message || e}`;
      return;
    }
    if (outcome === 'conflict') { log?.info('paper account changed underneath; reloading'); load(); return; }
    marksMoved = false;
    lastResult = { at: now(), results: results.length, symbol };
    log?.info('paper orders filled on the server', { symbol, results: results.length, version: held.version });
    emit();
  }

  /** A streamed price for a watched symbol. */
  function price({ symbol, price: p, at }) {
    if (!owner || paused || !account) return;
    if (!Number.isFinite(p) || !Number.isFinite(at)) return;
    if (at <= generationAt) return; // received before (or in the same millisecond as) the last outside change
    if (now() - at > freshMs) return; // waited too long (a backed-up queue): not a current price
    apply(symbol, p, at);
  }

  function takeOver() {
    owner = true;
    paused = null;
    load();
    log?.info('the server now fills paper orders (no main window open)');
  }

  /** The browser takes over: save moved marks once (compare-and-swap), then stop. Synchronous. */
  function handover() {
    if (!owner) return;
    owner = false;
    if (marksMoved && account && !paused) {
      try { commit([]); } catch (e) { log?.error('paper handover save failed', { error: e }); }
    }
    account = null;
    held = null;
    log?.info('a main window is open: the browser fills paper orders');
  }

  /** Re-checks ownership; call every few seconds. */
  function tick() {
    const present = presence.present();
    if (present && owner) handover();
    else if (!present && !owner) takeOver();
  }

  // Anything else changing the account: reload (the evaluator's own commits are skipped).
  // A successful outside change is a fresh start: it also lifts a pause from earlier storage errors.
  const offChange = sync.onChange((c) => {
    if (c.key !== 'paper') return;
    if (c.by === BY) return;
    if (owner) { paused = null; load(); } else emit();
  });
  const offEpoch = sync.onEpoch(() => { if (owner) { paused = null; load(); } else emit(); });

  return {
    tick,
    handover,
    price,
    symbols,
    /** fn(symbols) whenever the set of watched symbols may have changed. */
    onSymbols(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => ({ owner: owner ? 'server' : 'browser', paused, lastServerFill: lastResult, browserSeenAgoSec: Math.round((now() - presence.lastSeenAt) / 1000), watched: symbols() }),
    close() { offChange(); offEpoch(); },
  };
}
