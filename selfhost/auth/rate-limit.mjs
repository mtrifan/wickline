// Login throttling: an increasing delay per client after failed attempts, never a lockout (a LAN
// device must not be able to lock the owner out). In public mode a global minimum spacing between
// failed attempts also slows distributed guessing.

export function createLoginLimiter({ baseMs = 1000, maxMs = 60_000, globalSpacingMs = 0, forgetAfterMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const clients = new Map(); // key -> { failures, until, last }
  let globalUntil = 0;

  const sweep = () => {
    const t = now();
    for (const [k, v] of clients) if (t - v.last > forgetAfterMs) clients.delete(k);
  };

  return {
    /** Milliseconds the client must still wait before another attempt (0 = go ahead). */
    retryAfter(key) {
      const t = now();
      const c = clients.get(key);
      return Math.max(0, (c?.until ?? 0) - t, globalUntil - t);
    },
    fail(key) {
      const t = now();
      const c = clients.get(key) || { failures: 0, until: 0, last: t };
      c.failures += 1;
      c.last = t;
      c.until = t + Math.min(maxMs, baseMs * 2 ** (c.failures - 1));
      clients.set(key, c);
      if (globalSpacingMs) globalUntil = t + globalSpacingMs;
      if (clients.size > 10_000) sweep();
    },
    succeed(key) { clients.delete(key); },
    get size() { return clients.size; },
  };
}
