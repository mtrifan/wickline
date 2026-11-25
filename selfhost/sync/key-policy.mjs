// Which localStorage keys sync, and how concurrent writes to each are resolved (PLAN §2.4).
// The classification lives in key-classes.json, which a contract test keeps in step with upstream.
//
//   cas    compare-and-swap: a write applies only on top of the version it was based on
//   merge  three-way merge of an array of { id, ... } entries (scripts, alerts)
//   lww    last write wins (small preferences)
//   local  never leaves the device; the server refuses it
//
// Keys are named without the "wickline." prefix ("watchlist", "drawings.AAPL").

import { readFileSync } from 'node:fs';

const CLASSES = JSON.parse(readFileSync(new URL('./key-classes.json', import.meta.url), 'utf8')).keys;
export const POLICIES = new Set(['cas', 'merge', 'lww', 'local']);

for (const [k, c] of Object.entries(CLASSES)) {
  if (!POLICIES.has(c.policy)) throw new Error(`key-classes.json: ${k} has unknown policy ${c.policy}`);
}

const exact = new Map(Object.entries(CLASSES).filter(([k]) => !k.endsWith('*')).map(([k, c]) => [k, c.policy]));
const prefixes = Object.entries(CLASSES).filter(([k]) => k.endsWith('*')).map(([k, c]) => [k.slice(0, -1), c.policy]);

// drawings.<symbol> carries provider symbols ("^GSPC", "EURUSD=X", "BINANCE:BTCUSDT", "EUR/USD"), so
// any printable character is accepted. A key is only ever a bound SQL parameter or escaped JSON.
export const MAX_KEY_LENGTH = 200;
const KEY_RE = /^[^\s\p{Cc}\p{Cf}]+$/u;

export const isValidKey = (key) => typeof key === 'string' && key.length <= MAX_KEY_LENGTH && KEY_RE.test(key);

/**
 * The policy for a key: 'cas' | 'merge' | 'lww' | 'local', or null for a key upstream does not use
 * (which is refused like a local one). `syncWorkspace: false` keeps `workspace` on the device.
 */
export function policyFor(key, { syncWorkspace = true } = {}) {
  if (!isValidKey(key)) return null;
  if (key === 'workspace' && !syncWorkspace) return 'local';
  if (exact.has(key)) return exact.get(key);
  for (const [prefix, policy] of prefixes) {
    if (key.startsWith(prefix) && key.length > prefix.length) return policy;
  }
  return null;
}

/** True when a key is replicated between devices. */
export const isSynced = (key, opts) => {
  const p = policyFor(key, opts);
  return p !== null && p !== 'local';
};
