// Server-side bookkeeping for alerts (PLAN §2.5.6): the alerts merge as a sync hook, 30-day
// tombstones, trigger records, and exactly one push per trigger.
//
// A trigger is recorded and its notification queued in the same transaction as the alerts write
// that carries it, so a crash can lose neither half. The outbox dedups on `alert:<id>:<triggeredAt>`,
// so the same trigger reported again (a retried request, a second browser) is pushed once.

import { transaction } from '../storage/db.mjs';
import { parseIdArray } from '../sync/merge.mjs';
import { mergeAlerts, triggerTime, DUAL_WINDOW_MS, RECENT_MS } from './merge.mjs';

export const TOMBSTONE_MS = 30 * 86_400_000;

const CONDITION_TEXT = { cross: 'crossing', up: 'crossing up', down: 'crossing down' };

/**
 * Upstream's toast as a notification: "AAPL crossing up 190.5" / "Now 190.62 · message".
 * `gap`: the crossing happened while the server was restarting (the first price after it).
 */
export function alertPayload(a, publicUrl, { gap = false } = {}) {
  const symbol = String(a.symbol ?? '');
  const ticker = symbol.slice(symbol.indexOf(':') + 1) || symbol;
  return {
    title: `${ticker} ${CONDITION_TEXT[a.condition] || CONDITION_TEXT.cross} ${a.price}`,
    message: `Now ${a.triggerPrice}${gap ? ' (crossed while Wickline was restarting)' : ''}${a.message ? ` · ${a.message}` : ''}`,
    ...(publicUrl && symbol ? { url: `${publicUrl}/#s=${encodeURIComponent(symbol)}` } : {}),
  };
}

export const triggerKey = (id, at) => `${id}:${at}`;

export function createAlertLedger(db, { outbox, publicUrl = null, now = Date.now, dualWindowMs = DUAL_WINDOW_MS, recentMs = RECENT_MS, log } = {}) {
  const q = {
    get: db.prepare('SELECT last_trigger_key, trigger_version, tombstoned_at FROM alert_meta WHERE alert_id = ?'),
    setTrigger: db.prepare(`INSERT INTO alert_meta (alert_id, last_trigger_key, trigger_version) VALUES (?, ?, ?)
      ON CONFLICT (alert_id) DO UPDATE SET last_trigger_key = excluded.last_trigger_key, trigger_version = excluded.trigger_version`),
    tombstone: db.prepare(`INSERT INTO alert_meta (alert_id, status, tombstoned_at) VALUES (?, 'deleted', ?)
      ON CONFLICT (alert_id) DO UPDATE SET status = 'deleted', tombstoned_at = excluded.tombstoned_at`),
    purge: db.prepare('DELETE FROM alert_meta WHERE tombstoned_at IS NOT NULL AND tombstoned_at < ?'),
    clearTombstones: db.prepare('DELETE FROM alert_meta WHERE tombstoned_at IS NOT NULL'),
    progress: db.prepare(`INSERT INTO alert_meta (alert_id, last_price, last_tick_at, last_session) VALUES (?, ?, ?, ?)
      ON CONFLICT (alert_id) DO UPDATE SET last_price = excluded.last_price, last_tick_at = excluded.last_tick_at, last_session = excluded.last_session`),
    resume: db.prepare('SELECT alert_id, last_price, last_tick_at, last_session FROM alert_meta WHERE last_tick_at IS NOT NULL AND tombstoned_at IS NULL'),
  };
  let queued = false; // a notification was queued in the transaction in progress
  let state = null;

  const isTombstoned = (id) => {
    const r = q.get.get(id);
    return !!r && r.tombstoned_at != null && r.tombstoned_at >= now() - TOMBSTONE_MS;
  };
  /** { at, version } of the last recorded trigger, or null. */
  const lastTrigger = (id) => {
    const r = q.get.get(id);
    const k = r?.last_trigger_key;
    if (!k) return null;
    const at = Number(k.slice(k.lastIndexOf(':') + 1));
    return Number.isFinite(at) ? { at, version: r.trigger_version ?? null } : null;
  };
  const lastTriggerAt = (id) => lastTrigger(id)?.at ?? null;

  /** Records a trigger (in the alerts value's `version`) and queues its push, in the caller's transaction. */
  function record(alert, source, version, push = true, { gap = false } = {}) {
    const key = triggerKey(alert.id, alert.triggeredAt);
    q.setTrigger.run(alert.id, key, version);
    const n = outbox && push ? outbox.insert(`alert:${key}`, alertPayload(alert, publicUrl, { gap })) : 0;
    if (n) queued = true;
    log?.info('alert triggered', { id: alert.id, symbol: alert.symbol, source, queued: n });
  }

  function tombstone(ids) {
    const t = now();
    for (const id of ids) q.tombstone.run(id, t);
  }

  /** The sync hook for the `alerts` key (see state.useHook). All of it runs in the write's transaction. */
  const syncHook = {
    /** Returns the value to store, or null when a side is not an alerts array (last write wins). */
    merge({ cur, value, base, baseVersion, nextVersion }) {
      const ours = parseIdArray(cur); const theirs = parseIdArray(value); const b = parseIdArray(base);
      if (!ours || !theirs || !b) return null;
      q.purge.run(now() - TOMBSTONE_MS);
      const r = mergeAlerts({ base: b, ours, theirs, baseVersion, isTombstoned, lastTrigger, now: now(), dualWindowMs, recentMs });
      tombstone(r.removed);
      // A trigger reported long after it happened (a device back from days offline) is recorded, not pushed.
      for (const a of r.triggers) record(a, 'browser', nextVersion, Math.abs(now() - a.triggeredAt) <= recentMs);
      const out = JSON.stringify(r.merged);
      return out === JSON.stringify(theirs) ? value : out; // keep the client's exact text when nothing changed
    },
    /** The whole key is deleted: every alert in it is tombstoned. */
    onDelete(cur) {
      const ours = parseIdArray(cur);
      if (ours) tombstone(ours.map((a) => a.id));
    },
    /** An import replaces every alert: earlier deletions no longer apply. */
    onReplace() { q.clearTombstones.run(); },
    afterCommit() {
      if (queued) { queued = false; outbox?.kick(); }
    },
    rollback() { queued = false; },
  };

  /**
   * A trigger the server detected (PLAN §2.5.6): marks the alert fired in the `alerts` value
   * (a new version, broadcast to browsers) and queues its push, in one transaction. Does nothing
   * if the alert is gone or no longer armed (a browser recorded the crossing first).
   * Returns { fired, key? }.
   */
  function trigger({ id, triggerPrice, triggeredAt = now(), gap = false }) {
    if (!state) throw new Error('createAlertLedger: attach(state) first');
    let fired = null;
    state.mutate('alerts', (cur, { version }) => {
      const items = parseIdArray(cur);
      const a = items?.find((x) => x.id === id);
      if (!a || triggerTime(a) !== null || a.active !== true) return undefined;
      Object.assign(a, { active: false, triggeredAt, triggerPrice });
      record(a, 'server', version, true, { gap });
      fired = triggerKey(id, triggeredAt);
      return JSON.stringify(items);
    }, { by: 'server', hook: syncHook });
    return fired ? { fired: true, key: fired } : { fired: false };
  }

  /** Stores the worker's latest prices (id -> { price, at, session }) for resuming after a restart. */
  function saveProgress(points) {
    const rows = Object.entries(points || {}).filter(([, p]) => p && Number.isFinite(p.price) && Number.isFinite(p.at));
    if (!rows.length) return;
    transaction(db, () => { for (const [id, p] of rows) q.progress.run(id, p.price, p.at, Number.isInteger(p.session) ? p.session : null); });
  }

  /** The stored progress: id -> { price, at, session }. */
  function resumePoints() {
    const out = {};
    for (const r of q.resume.all()) out[r.alert_id] = { price: r.last_price, at: r.last_tick_at, session: r.last_session ?? 1 };
    return out;
  }

  /** Wires the ledger into the sync state: the alerts merge, and server triggers. */
  function attach(s) {
    state = s;
    s.useHook('alerts', syncHook);
  }

  return { attach, trigger, saveProgress, resumePoints, isTombstoned, lastTrigger, lastTriggerAt, syncHook };
}
