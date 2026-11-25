-- Schema v3: server-side alerts and notifications (PLAN §2.5, §2.6).

-- Server-side state per alert id (the alerts themselves stay in kv_state 'alerts'):
-- the last trigger seen (server or browser), the evaluator's resume point, and a 30-day tombstone
-- after deletion so a stale browser cannot bring the alert back.
CREATE TABLE alert_meta (
  alert_id         TEXT PRIMARY KEY,
  last_trigger_key TEXT,
  last_price       REAL,
  last_tick_at     INTEGER,
  last_session     INTEGER,
  status           TEXT,
  tombstoned_at    INTEGER
);

-- Pending and delivered notifications. One row per (provider, dedup_key): an alert trigger is
-- pushed once per provider however many times it is reported. Delivery is at-least-once.
CREATE TABLE notification_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key       TEXT NOT NULL,
  provider        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  last_error      TEXT,
  last_attempt_at INTEGER,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (provider, dedup_key)
);
CREATE INDEX notification_outbox_due ON notification_outbox (status, next_attempt_at);
