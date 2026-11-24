-- Schema v1: installation metadata, login sessions, API tokens, audit log.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- id is the SHA-256 of the cookie value, so a copy of the database cannot be used to log in.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- hash is the SHA-256 of the token; the token itself is shown once, at creation.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  hash         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  event   TEXT NOT NULL,
  ip      TEXT,
  detail  TEXT
);
CREATE INDEX audit_log_at ON audit_log (at);
