// Three-way merge for keys holding an array of { id, ... } entries (scripts, alerts).
//
// Given the version a client started from (base), the server's current value (ours) and the
// client's write (theirs), each entry is resolved on its own:
//   - changed on one side only      → that side wins (an addition, an edit or a deletion)
//   - changed identically           → either
//   - edited on both sides          → the higher numeric `updated` wins (scripts). Entries without
//                                     `updated` (alerts) merge field by field against the base:
//                                     a field changed on one side only keeps that change, so
//                                     fields the server writes survive a stale browser write;
//                                     a field changed on both sides takes the client's value
//   - edited on one, deleted on other → the edit wins: a merge never discards someone's work
// Order follows the server's array, with entries new to the client appended in its order.
//
// Without a base (the client's version was pruned from history) nothing can be inferred as
// deleted, so entries from both sides are kept and conflicting edits use the rule above.

/** Parses an id-array value; null if it is not one (the caller then falls back to last write wins). */
export function parseIdArray(text) {
  if (text == null) return [];
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(v)) return null;
  const seen = new Set();
  for (const e of v) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.id !== 'string' || !e.id || seen.has(e.id)) return null;
    seen.add(e.id);
  }
  return v;
}

const byId = (arr) => new Map(arr.map((e) => [e.id, JSON.stringify(e)]));
const updatedOf = (json) => { const u = JSON.parse(json).updated; return typeof u === 'number' && Number.isFinite(u) ? u : null; };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mergeFields(b, o, t) {
  const [bo, oo, to] = [JSON.parse(b), JSON.parse(o), JSON.parse(t)];
  const out = {};
  for (const k of new Set([...Object.keys(oo), ...Object.keys(to)])) {
    const v = same(to[k], bo[k]) ? oo[k] : to[k]; // client left the field alone → server's
    if (v !== undefined) out[k] = v;
  }
  return JSON.stringify(out);
}

function resolveBoth(o, t, b) {
  const uo = updatedOf(o); const ut = updatedOf(t);
  if (uo !== null && ut !== null) return uo > ut ? o : t;
  return b !== undefined ? mergeFields(b, o, t) : t;
}

/**
 * Merges three parsed id-arrays. `base` may be null (unknown). Returns the merged array.
 */
export function mergeIdArrays(base, ours, theirs) {
  const b = base ? byId(base) : null;
  const o = byId(ours);
  const t = byId(theirs);
  const order = [...o.keys(), ...[...t.keys()].filter((id) => !o.has(id))];
  const out = [];
  for (const id of order) {
    const os = o.get(id); const ts = t.get(id);
    let pick;
    if (os === ts) pick = os;
    else if (!b) pick = os === undefined ? ts : ts === undefined ? os : resolveBoth(os, ts);
    else {
      const bs = b.get(id);
      if (ts === bs) pick = os; // client left it alone
      else if (os === bs) pick = ts; // server left it alone
      else if (os === undefined) pick = ts; // deleted here, edited there: keep the edit
      else if (ts === undefined) pick = os;
      else pick = resolveBoth(os, ts, bs);
    }
    if (pick !== undefined) out.push(JSON.parse(pick));
  }
  return out;
}
