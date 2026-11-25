// Synced browser state on the server (PLAN §2.4): snapshots, policy-checked writes, and the change
// feed behind the event stream. Every write runs in one SQLite transaction, which assigns the
// key's next version and the next global rev, so concurrent writes are strictly ordered.

import { randomBytes } from 'node:crypto';
import { transaction } from '../storage/db.mjs';
import { policyFor } from './key-policy.mjs';
import { parseIdArray, mergeIdArrays } from './merge.mjs';

/** localStorage holds about 5 million UTF-16 characters per origin; no single value can be larger. */
export const MAX_VALUE_CHARS = 5_000_000;
/**
 * Totals across all synced keys. Every synced value also lives in a browser's localStorage, which
 * holds about 5 million characters, so these limits only stop a runaway or hostile client.
 */
export const MAX_TOTAL_CHARS = 10_000_000;
export const MAX_KEYS = 5_000;
/** Rows including tombstones. Beyond it the oldest tombstones are pruned (see meta.pruned_rev). */
export const MAX_ROWS = 10_000;
/** Versions of each merged key kept for three-way merges, within a size budget per key. */
export const HISTORY_DEPTH = 20;
export const HISTORY_MAX_CHARS = 2_000_000;

/** A refused write. `body` is sent to the client as JSON with `status`. */
export class SyncError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

const newEpoch = () => randomBytes(8).toString('hex');

export function createSyncState(db, { syncWorkspace = true, now = Date.now, log, maxTotalChars = MAX_TOTAL_CHARS, maxKeys = MAX_KEYS, maxRows = MAX_ROWS } = {}) {
  const opts = { syncWorkspace };
  const listeners = new Set();
  const epochListeners = new Set();

  const q = {
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    nextRev: db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'state_rev' RETURNING CAST(value AS INTEGER) AS rev"),
    row: db.prepare('SELECT value, deleted, version, rev FROM kv_state WHERE key = ?'),
    all: db.prepare('SELECT key, value, deleted, version, rev, updated_by FROM kv_state WHERE rev > ? ORDER BY rev'),
    upsert: db.prepare(`INSERT INTO kv_state (key, value, size, deleted, version, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, size = excluded.size, deleted = excluded.deleted, version = excluded.version,
      rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    history: db.prepare('SELECT value FROM kv_history WHERE key = ? AND version = ?'),
    addHistory: db.prepare('INSERT OR REPLACE INTO kv_history (key, version, value, size, created_at) VALUES (?, ?, ?, ?, ?)'),
    pruneHistory: db.prepare('DELETE FROM kv_history WHERE key = ? AND version <= ?'),
    historySizes: db.prepare('SELECT version, size FROM kv_history WHERE key = ? ORDER BY version DESC'),
    // A workspace stored before SYNC_WORKSPACE=false neither syncs nor counts.
    usage: db.prepare('SELECT COALESCE(SUM(size), 0) AS chars, COUNT(*) FILTER (WHERE deleted = 0) AS keys, COUNT(*) AS rows FROM kv_state WHERE key != ?'),
    oldestTombstones: db.prepare('SELECT key, rev FROM kv_state WHERE deleted = 1 ORDER BY rev LIMIT ?'),
    deleteRow: db.prepare('DELETE FROM kv_state WHERE key = ?'),
  };

  const epoch = () => q.meta.get('epoch').value;
  const rev = () => Number(q.meta.get('state_rev').value);
  const prunedRev = () => Number(q.meta.get('pruned_rev')?.value ?? 0);
  const excluded = syncWorkspace ? '' : 'workspace';

  /** Removes the oldest tombstones so that `room` more rows fit under maxRows. */
  function pruneTombstones(rows, room) {
    const over = rows + room - maxRows;
    if (over <= 0) return;
    let floor = prunedRev();
    for (const t of q.oldestTombstones.all(over)) { q.deleteRow.run(t.key); floor = Math.max(floor, t.rev); }
    q.setMeta.run('pruned_rev', String(floor));
  }

  /** Keeps the newest HISTORY_DEPTH versions of a key, and only as many as fit HISTORY_MAX_CHARS. */
  function pruneHistory(key, version) {
    q.pruneHistory.run(key, version - HISTORY_DEPTH);
    let total = 0;
    for (const [i, h] of q.historySizes.all(key).entries()) {
      total += h.size;
      if (i > 0 && total > HISTORY_MAX_CHARS) { q.pruneHistory.run(key, h.version); break; }
    }
  }
  const synced = (key) => { const p = policyFor(key, opts); return p !== null && p !== 'local'; };
  const toChange = (r) => ({ key: r.key, v: r.deleted ? null : r.value, ver: r.version, deleted: !!r.deleted, rev: r.rev, by: r.updated_by || null });

  /** Every synced key with rev > since, oldest first (tombstones included). */
  function changesSince(since) {
    return q.all.all(since).filter((r) => synced(r.key)).map(toChange);
  }

  /** { epoch, rev, keys: { key: { v, ver, deleted } } }, read in one transaction so it is consistent. */
  function snapshot() {
    return transaction(db, () => {
      const keys = {};
      for (const c of changesSince(0)) keys[c.key] = { v: c.v, ver: c.ver, deleted: c.deleted };
      return { epoch: epoch(), rev: rev(), keys };
    });
  }

  function mergedValue(key, cur, value, baseVersion) {
    const ours = parseIdArray(cur);
    const theirs = parseIdArray(value);
    if (!ours || !theirs) return value; // not an id-array (any more): last write wins rather than wedging sync
    let base = [];
    if (baseVersion > 0) {
      const h = q.history.get(key, baseVersion);
      base = h ? parseIdArray(h.value) : null; // pruned or unreadable: merge without inferring deletions
    }
    return JSON.stringify(mergeIdArrays(base, ours, theirs));
  }

  /**
   * Applies a write (`value: null` deletes). Returns { version, rev, deleted, changed, value? }, where
   * `value` is present only when the stored value differs from the one sent (a merge), so the client
   * can adopt it. Throws SyncError: 422 for a key that does not sync, 409 for a stale epoch or a
   * compare-and-swap conflict (with the current value, so the client can re-hydrate that key).
   */
  function write(key, { value, baseVersion, epoch: clientEpoch, clientId = null }) {
    const policy = policyFor(key, opts);
    if (policy === null || policy === 'local') throw new SyncError(422, { error: 'This key is not synced' });
    const del = value === null;

    const result = transaction(db, () => {
      if (clientEpoch !== epoch()) throw new SyncError(409, { error: 'epoch', epoch: epoch() });
      const row = q.row.get(key);
      const curVer = row ? row.version : 0;
      const curDeleted = !row || row.deleted === 1;
      const cur = curDeleted ? null : row.value;
      const unchanged = (v) => (v === null ? curDeleted : !curDeleted && cur === v);

      if (unchanged(value)) return { version: curVer, rev: row ? row.rev : 0, deleted: curDeleted, changed: false };

      let stored = value;
      if (policy === 'cas' || (policy === 'merge' && del)) {
        if (baseVersion !== curVer) throw new SyncError(409, { error: 'conflict', version: curVer, value: cur, deleted: curDeleted });
      } else if (policy === 'merge' && baseVersion !== curVer) {
        // The whole key was deleted after the client's base: recreating it must be deliberate.
        if (curDeleted && row) throw new SyncError(409, { error: 'conflict', version: curVer, value: null, deleted: true });
        stored = mergedValue(key, cur, value, baseVersion);
        if (unchanged(stored)) return { version: curVer, rev: row.rev, deleted: false, changed: false, value: stored };
      }

      const use = q.usage.get(excluded);
      if (stored !== null) {
        const chars = Number(use.chars) - (cur ? cur.length : 0) + stored.length;
        const keys = Number(use.keys) + (curDeleted ? 1 : 0);
        if (chars > maxTotalChars || keys > maxKeys) throw new SyncError(413, { error: 'Synced state quota exceeded' });
      }
      if (!row) pruneTombstones(Number(use.rows), 1);

      const version = curVer + 1;
      const { rev: next } = q.nextRev.get();
      const at = now();
      q.upsert.run(key, stored, stored === null ? 0 : stored.length, del ? 1 : 0, version, next, at, clientId);
      if (policy === 'merge') {
        q.addHistory.run(key, version, stored, stored === null ? 0 : stored.length, at);
        pruneHistory(key, version);
      }
      const out = { version, rev: next, deleted: del, changed: true, change: { key, v: stored, ver: version, deleted: del, rev: next, by: clientId } };
      if (stored !== value) out.value = stored;
      return out;
    });

    if (result.changed) {
      const { change } = result;
      delete result.change;
      // Broadcast failures never change the result of a committed write.
      for (const fn of listeners) {
        try { fn(change); } catch (e) { log?.error('sync listener failed', { error: e }); }
      }
    }
    return result;
  }

  /** Every live synced value: { key: value } (the portable export; deletions are not exported). */
  function exportKeys() {
    const keys = {};
    for (const c of changesSince(0)) if (!c.deleted) keys[c.key] = c.v;
    return keys;
  }

  /**
   * Replaces all synced state with `keys` ({ key: value }) and starts a new epoch, so every browser
   * re-hydrates from it. Rows of keys that do not sync (a workspace kept with SYNC_WORKSPACE=false)
   * are left alone. Throws SyncError 422 for an invalid or unsynced key, 413 beyond the quota.
   */
  function replaceAll(keys) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new SyncError(422, { error: 'keys must be an object' });
    const accepted = [];
    const skipped = [];
    let chars = 0;
    for (const [k, v] of Object.entries(keys)) {
      // Device-local here (workspace with SYNC_WORKSPACE=false) but synced where it was exported: skip it.
      if (policyFor(k, opts) === 'local') { skipped.push(k); continue; }
      if (!synced(k)) throw new SyncError(422, { error: `Not a synced key: ${String(k).slice(0, 80)}` });
      if (typeof v !== 'string') throw new SyncError(422, { error: `The value of ${k} must be a string` });
      if (v.length > MAX_VALUE_CHARS) throw new SyncError(413, { error: `The value of ${k} is too large` });
      chars += v.length;
      accepted.push([k, v]);
    }
    if (chars > maxTotalChars || accepted.length > maxKeys) throw new SyncError(413, { error: 'Synced state quota exceeded' });
    const e = newEpoch();
    transaction(db, () => {
      for (const r of q.all.all(0)) if (synced(r.key)) q.deleteRow.run(r.key);
      db.exec('DELETE FROM kv_history');
      q.setMeta.run('pruned_rev', String(rev()));
      const at = now();
      for (const [k, v] of accepted) q.upsert.run(k, v, v.length, 0, 1, q.nextRev.get().rev, at, 'import');
      q.setMeta.run('epoch', e); // with the data: never imported data under the old epoch
    });
    notifyEpoch(e);
    return { keys: accepted.length, skipped, epoch: e };
  }

  /** Starts a new epoch (restore, import): browsers holding the old one re-hydrate. */
  function resetEpoch() {
    const e = newEpoch();
    q.setMeta.run('epoch', e);
    notifyEpoch(e);
    return e;
  }

  function notifyEpoch(e) {
    for (const fn of epochListeners) {
      try { fn(e); } catch (err) { log?.error('epoch listener failed', { error: err }); }
    }
  }

  /** Calls fn(epoch) after every resetEpoch(). Returns an unsubscribe function. */
  function onEpoch(fn) { epochListeners.add(fn); return () => epochListeners.delete(fn); }

  /** Calls fn(change) after every committed change. Returns an unsubscribe function. */
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { epoch, rev, prunedRev, snapshot, write, changesSince, exportKeys, replaceAll, resetEpoch, onChange, onEpoch, policyFor: (k) => policyFor(k, opts) };
}
