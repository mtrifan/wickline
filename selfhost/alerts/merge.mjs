// The alerts merge (PLAN §2.5.6): applies a browser's intent to the server's current alerts.
//
// The client's intent is what changed between its base (the version it started from) and what
// it sent: ids it added, removed or edited. That intent is applied to the server's current value,
// so a stale browser never undoes what it did not see:
//   - ids added elsewhere stay; ids deleted anywhere stay deleted (30-day tombstones)
//   - other fields merge one by one: a field the client changed takes the client's value
//   - the trigger fields (active, triggeredAt, triggerPrice) are server-owned. A browser can change
//     them in exactly two ways:
//       trigger  it saw the alert armed and detected a crossing. Accepted while the server still
//                has the alert armed, unless the same crossing was already recorded: a trigger the
//                client's base did not contain, or, after a re-arm elsewhere, one within the dual
//                window recorded after the client's base. Then it collapses into the recorded one,
//                which was the one pushed.
//       new      an alert the server never had, uploaded already fired (created and fired offline),
//                is pushed if it fired within RECENT_MS; older triggers are history, not news.
//       re-arm   accepted only if the client's base contained the trigger it clears, so a stale
//                browser can neither cancel a newer trigger nor cause a second push.
// A trigger is identified by `${id}:${triggeredAt}`.

export const TRIGGER_FIELDS = ['active', 'triggeredAt', 'triggerPrice'];
export const DUAL_WINDOW_MS = 120_000;
export const RECENT_MS = 15 * 60_000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The trigger time of a fired alert, or null while it is armed. */
export const triggerTime = (a) => (a && a.active === false && Number.isFinite(a.triggeredAt) ? a.triggeredAt : null);

/** A fired alert's fields that are not server-owned merge one by one against the base. */
function mergeOtherFields(b, o, t) {
  const out = Object.create(null); // a "__proto__" field stays an ordinary field
  for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
    if (TRIGGER_FIELDS.includes(k)) { if (k in o) out[k] = o[k]; continue; }
    const v = same(t[k], b[k]) ? o[k] : t[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Resolves the trigger fields of one alert present in base, ours and theirs. Returns
 * { fields, trigger } where `fields` are the trigger fields to store and `trigger` is set when the
 * client's trigger is accepted as a new one.
 */
function resolveTrigger(b, o, t, { last, baseVersion, dualWindowMs }) {
  const keep = { fields: pick(o), trigger: null };
  const bT = triggerTime(b); const oT = triggerTime(o); const tT = triggerTime(t);

  if (tT !== null && tT !== bT) { // the client reports a trigger it detected
    const sawServer = oT === bT; // the client's base holds the server's current trigger state
    if (!sawServer) return keep; // the server recorded a trigger the client did not see: same arming
    // Re-armed elsewhere after a trigger this client's base predates: the same crossing, reported
    // late. A client whose base includes that trigger (and the re-arm) reports a new crossing.
    const stale = last && last.at !== bT && last.version != null && baseVersion < last.version;
    if (stale && Math.abs(tT - last.at) <= dualWindowMs) return keep;
    return { fields: pick(t), trigger: tT };
  }
  if (t.active === true && bT !== null && tT === null) { // the client re-armed
    return oT === bT ? { fields: { active: true, triggeredAt: null, triggerPrice: null }, trigger: null } : keep;
  }
  return keep; // any other change to server-owned fields is ignored
}

const pick = (a) => Object.fromEntries(TRIGGER_FIELDS.filter((k) => k in a).map((k) => [k, a[k]]));

/**
 * Merges parsed alert arrays.
 *   base         the client's base (the server's version it started from; [] for none)
 *   ours         the server's current value
 *   theirs       what the client sent
 *   baseVersion  the version of the client's base
 *   isTombstoned id → true if deleted within the tombstone period
 *   lastTrigger  id → { at, version } of the last recorded trigger (server or browser), or null
 *   now          the server's clock, for RECENT_MS
 * Returns { merged, removed, triggers }: the value to store, ids the client deleted (to tombstone),
 * and the alerts whose client trigger was accepted (to record and push).
 */
export function mergeAlerts({ base, ours, theirs, baseVersion = 0, isTombstoned = () => false, lastTrigger = () => null, now = Date.now(), dualWindowMs = DUAL_WINDOW_MS, recentMs = RECENT_MS }) {
  const b = new Map(base.map((a) => [a.id, a]));
  const o = new Map(ours.map((a) => [a.id, a]));
  const t = new Map(theirs.map((a) => [a.id, a]));
  const removed = [];
  const triggers = [];
  const resolved = new Map();

  for (const [id, oa] of o) {
    const ba = b.get(id); const ta = t.get(id);
    if (!ba) { resolved.set(id, oa); continue; } // added elsewhere (or no base to compare): server's copy
    if (!ta) { removed.push(id); continue; } // the client deleted it
    if (same(ta, ba)) { resolved.set(id, oa); continue; } // the client left it alone
    const { fields, trigger } = resolveTrigger(ba, oa, ta, { last: lastTrigger(id), baseVersion, dualWindowMs });
    const merged = { ...mergeOtherFields(ba, oa, ta) };
    for (const k of TRIGGER_FIELDS) { if (k in fields) merged[k] = fields[k]; }
    resolved.set(id, merged);
    if (trigger !== null) triggers.push(merged);
  }
  for (const id of b.keys()) if (!o.has(id) && !t.has(id)) removed.push(id); // already gone: tombstone anyway

  // Ids new to the client. Deleted ones (here, or anywhere within the tombstone period) stay deleted.
  const added = theirs.filter((a) => !b.has(a.id) && !o.has(a.id) && !isTombstoned(a.id));
  const addedIds = new Set(added.map((a) => a.id));
  for (const a of added) {
    const at = triggerTime(a);
    if (at !== null && Math.abs(now - at) <= recentMs) triggers.push(a);
  }
  // Upstream puts new alerts first: additions ahead of every known id keep that place.
  let lead = 0;
  while (lead < theirs.length && addedIds.has(theirs[lead].id)) lead++;
  const front = theirs.slice(0, lead);
  const back = added.filter((a) => !front.includes(a));

  const merged = [...front, ...ours.filter((a) => resolved.has(a.id)).map((a) => resolved.get(a.id)), ...back];
  return { merged, removed, triggers };
}
