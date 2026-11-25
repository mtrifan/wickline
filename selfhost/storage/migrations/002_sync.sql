-- Schema v2: synced browser state (PLAN §2.4).
--
-- kv_state holds one row per synced localStorage key (without the "wickline." prefix). A deletion
-- is a tombstone (deleted = 1, value NULL) so that it replicates like any other change. `version`
-- counts changes to one key and drives compare-and-swap; `rev` is a global sequence
-- (meta.state_rev) that orders every change and lets an event stream resume from Last-Event-ID.
-- `size` is the value's length (JavaScript string length), kept so the quota check never reads values.
CREATE TABLE kv_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE UNIQUE INDEX kv_state_rev ON kv_state (rev);

-- Recent versions of the id-merged keys (scripts, alerts), so a three-way merge can find the
-- version a client started from. Pruned to the last few versions per key, and by total size.
CREATE TABLE kv_history (
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  value      TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, version)
);

-- epoch changes on restore and import; browsers holding state from another epoch re-hydrate
-- instead of writing it back. It is random rather than a counter, so restoring an old backup can
-- never land on an epoch a browser has already seen.
INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', lower(hex(randomblob(8))));
INSERT OR IGNORE INTO meta (key, value) VALUES ('state_rev', '0');
-- The highest rev of a tombstone pruned to make room (see MAX_ROWS): a stream resuming from an
-- earlier rev may have missed that deletion and is reset to a snapshot instead.
INSERT OR IGNORE INTO meta (key, value) VALUES ('pruned_rev', '0');
