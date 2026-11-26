// Stable shard assignment for streaming sources: a symbol keeps its shard while it stays watched,
// so arming or disarming one alert reconnects at most the shards that actually change (one, as a
// rule) instead of every shard after it in sort order.

/**
 * Given the current shards (arrays of tickers) and the wanted tickers, returns the new shards:
 * gone tickers are removed from their shard, new ones fill the emptiest shards with room, then new
 * shards. Shards whose membership did not change are returned as the same array object.
 */
export function assignShards(current, wanted, perConn) {
  const want = new Set(wanted);
  const placed = new Set();
  const out = [];
  for (const shard of current) {
    const keep = shard.filter((t) => want.has(t) && !placed.has(t));
    keep.forEach((t) => placed.add(t));
    if (!keep.length) continue;
    out.push(keep.length === shard.length ? shard : keep);
  }
  const fresh = [...want].filter((t) => !placed.has(t)).sort();
  for (const t of fresh) {
    let target = null;
    for (let i = 0; i < out.length; i++) {
      if (out[i].length < perConn && (!target || out[i].length < out[target.i].length)) target = { i };
    }
    if (target) out[target.i] = [...out[target.i], t]; // a new array: that shard reconnects
    else out.push([t]);
  }
  return out;
}
