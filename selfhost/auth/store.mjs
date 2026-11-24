// Sessions, API tokens, the TOTP replay counter and the audit log, in SQLite.
// Only SHA-256 digests of cookie values and tokens are stored.

import { randomBytes, createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const HOUR = 3600_000;

export function createAuthStore(db, { sessionDays = 30, now = () => Date.now() } = {}) {
  const ttl = sessionDays * 24 * HOUR;
  const q = {
    insertSession: db.prepare('INSERT INTO sessions (id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)'),
    getSession: db.prepare('SELECT id, created_at, last_seen_at, expires_at FROM sessions WHERE id = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteAllSessions: db.prepare('DELETE FROM sessions'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    insertToken: db.prepare('INSERT INTO api_tokens (id, hash, label, created_at) VALUES (?, ?, ?, ?)'),
    tokenByHash: db.prepare('SELECT id, label, last_used_at FROM api_tokens WHERE hash = ?'),
    useToken: db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?'),
    listTokens: db.prepare('SELECT id, label, created_at, last_used_at FROM api_tokens ORDER BY created_at'),
    deleteToken: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    audit: db.prepare('INSERT INTO audit_log (at, event, ip, detail) VALUES (?, ?, ?, ?)'),
    auditTrim: db.prepare('DELETE FROM audit_log WHERE at < ?'),
  };

  return {
    /** Creates a session; returns the cookie value (never stored). */
    createSession({ userAgent = '', ip = '' } = {}) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      q.insertSession.run(sha256(token), t, t, t + ttl, String(userAgent).slice(0, 300), ip);
      return { token, expiresAt: t + ttl };
    },
    /** Valid session for a cookie value, sliding its expiry at most once an hour; else null. */
    getSession(token) {
      if (!token || token.length > 200) return null;
      const id = sha256(token);
      const s = q.getSession.get(id);
      const t = now();
      if (!s) return null;
      if (s.expires_at <= t) { q.deleteSession.run(id); return null; }
      if (t - s.last_seen_at > HOUR) q.touchSession.run(t, t + ttl, id);
      return { id, expiresAt: Math.max(s.expires_at, t - s.last_seen_at > HOUR ? t + ttl : s.expires_at) };
    },
    deleteSession(token) { if (token) q.deleteSession.run(sha256(token)); },
    deleteAllSessions() { q.deleteAllSessions.run(); },
    purgeExpired() { q.purge.run(now()); q.auditTrim.run(now() - 180 * 24 * HOUR); },

    createToken(label) {
      const token = `wl_${randomBytes(32).toString('base64url')}`;
      const id = randomBytes(6).toString('hex');
      q.insertToken.run(id, sha256(token), String(label || 'token').slice(0, 80), now());
      return { id, token };
    },
    checkToken(token) {
      if (!token || !token.startsWith('wl_') || token.length > 200) return null;
      const row = q.tokenByHash.get(sha256(token));
      if (!row) return null;
      // Audited at most once an hour per token, so scripts do not flood the log.
      if (!row.last_used_at || now() - row.last_used_at > HOUR) q.audit.run(now(), 'token.use', '', row.id);
      q.useToken.run(now(), row.id);
      return { id: row.id, label: row.label };
    },
    listTokens: () => q.listTokens.all(),
    deleteToken: (id) => q.deleteToken.run(id).changes > 0,

    /** Highest TOTP counter accepted so far (replay protection across restarts). */
    getTotpCounter: () => Number(q.getMeta.get('totp_last_counter')?.value ?? -1),
    setTotpCounter: (c) => q.setMeta.run('totp_last_counter', String(c)),

    audit(event, { ip = '', detail = '' } = {}) { q.audit.run(now(), event, ip, typeof detail === 'string' ? detail : JSON.stringify(detail)); },
  };
}
