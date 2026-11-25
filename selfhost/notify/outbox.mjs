// Notification outbox (PLAN §2.6): queued pushes survive restarts and are retried with
// exponential backoff and jitter (5 s up to 30 min) until NOTIFY_MAX_ATTEMPTS. Permanent errors
// (4xx other than 408/429) fail at once. One row per (provider, dedup key), so a trigger reported
// twice is pushed once. Delivery is at-least-once: a crash between a successful send and its
// commit can repeat that one message after the restart.

const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30 * 60_000;
const KEEP_DAYS = 30;

/** Delay before attempt n+1 after n failed attempts: 5 s * 2^(n-1), capped, with 50-100 % jitter. */
export function backoffMs(attempts, random = Math.random) {
  const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

export function createOutbox(db, { providers = [], maxAttempts = 8, log, now = Date.now, random = Math.random } = {}) {
  const q = {
    insert: db.prepare(`INSERT INTO notification_outbox (dedup_key, provider, payload, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (provider, dedup_key) DO NOTHING`),
    due: db.prepare("SELECT id, dedup_key, provider, payload, attempts FROM notification_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 20"),
    next: db.prepare("SELECT MIN(next_attempt_at) AS at FROM notification_outbox WHERE status = 'pending'"),
    sent: db.prepare("UPDATE notification_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?"),
    retry: db.prepare('UPDATE notification_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_attempt_at = ?, last_error = ? WHERE id = ?'),
    failed: db.prepare("UPDATE notification_outbox SET status = 'failed', attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?"),
    pending: db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status = 'pending'"),
    last: db.prepare('SELECT provider, status, attempts, last_error, last_attempt_at, sent_at FROM notification_outbox WHERE last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC, id DESC LIMIT 1'),
    prune: db.prepare("DELETE FROM notification_outbox WHERE status IN ('sent', 'failed') AND created_at < ?"),
  };
  const configured = () => providers.filter((p) => p.isConfigured());
  const byId = (id) => providers.find((p) => p.id === id);
  let timer = null;
  let running = false;
  let active = false; // timers run only between start() and stop()
  let stopped = false;
  let lastResult = null;

  /**
   * Queues a notification for every configured provider. `key` identifies the event (for example
   * "alert:<id>:<triggeredAt>"); queueing the same key again is a no-op. Returns the number queued.
   */
  function enqueue(key, payload) {
    let n = 0;
    const t = now();
    for (const p of configured()) n += Number(q.insert.run(key, p.id, JSON.stringify(payload), t, t).changes);
    if (n) kick();
    return n;
  }

  async function processDue() {
    if (running || stopped) return;
    running = true;
    try {
      for (;;) {
        const rows = q.due.all(now());
        if (!rows.length) break;
        for (const row of rows) {
          if (stopped) return;
          const provider = byId(row.provider);
          const attempt = row.attempts + 1;
          let r;
          if (!provider || !provider.isConfigured()) r = { ok: false, retryable: false, error: `${row.provider} is no longer configured` };
          else {
            try { r = await provider.send(JSON.parse(row.payload)); } catch (e) { r = { ok: false, retryable: true, error: e?.message || String(e) }; }
          }
          const t = now();
          lastResult = { provider: row.provider, ok: r.ok, error: r.error ?? null, at: t };
          if (r.ok) {
            q.sent.run(t, t, row.id);
            log?.info('notification sent', { provider: row.provider, key: row.dedup_key, attempt });
          } else if (r.retryable && attempt < maxAttempts) {
            const wait = Math.min(MAX_DELAY_MS, Math.max(backoffMs(attempt, random), (r.retryAfterSec ?? 0) * 1000));
            q.retry.run(t + wait, t, r.error ?? null, row.id);
            log?.warn('notification failed; will retry', { provider: row.provider, key: row.dedup_key, attempt, retryInSec: Math.round(wait / 1000), error: r.error });
          } else {
            q.failed.run(t, r.error ?? null, row.id);
            log?.error('notification failed permanently', { provider: row.provider, key: row.dedup_key, attempt, error: r.error });
          }
        }
      }
      q.prune.run(now() - KEEP_DAYS * 86_400_000);
    } finally {
      running = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!active || stopped) return;
    const at = q.next.get().at;
    if (at == null) return;
    timer = setTimeout(() => { processDue().catch((e) => log?.error('outbox failed', { error: e })); }, Math.max(0, at - now()));
    timer.unref?.();
  }

  function kick() { if (!running) schedule(); }

  /** Starts delivering (including anything left from before a restart). */
  function start() { active = true; stopped = false; kick(); }
  function stop() { active = false; stopped = true; clearTimeout(timer); }

  /** For the settings page: never includes tokens. */
  function status() {
    const last = q.last.get();
    return {
      providers: providers.map((p) => ({ id: p.id, configured: p.isConfigured(), target: p.isConfigured() ? p.target ?? null : null })),
      pending: q.pending.get().n,
      last: last ? { provider: last.provider, status: last.status, attempts: last.attempts, error: last.last_error, at: last.last_attempt_at, sentAt: last.sent_at } : null,
    };
  }

  /** Sends straight away to every configured provider and reports each result (the test button). */
  async function sendNow(payload) {
    const results = [];
    for (const p of configured()) {
      let r;
      try { r = await p.send(payload); } catch (e) { r = { ok: false, retryable: true, error: e?.message || String(e) }; }
      results.push({ provider: p.id, ok: r.ok, status: r.status ?? null, error: r.error ?? null });
    }
    return results;
  }

  return { enqueue, start, stop, status, sendNow, processDue, get lastResult() { return lastResult; } };
}
