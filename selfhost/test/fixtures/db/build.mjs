// Builds a migration fixture: a database at schema N holding known data, so later releases can prove
// it upgrades to their schema without losing anything (test/unit/migration-fixtures.test.mjs).
//
//   node selfhost/test/fixtures/db/build.mjs <N>      writes schema-<N>.db and schema-<N>.json here
//
// Run it for the current schema when cutting a release that changed the schema (UPSTREAM.md, "Cutting
// a release"); the release workflow refuses to publish without a fixture for the current schema.
// Fixtures are never rebuilt: each one is the database an older release really wrote.
// The credentials inside are for this test database only.

import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, loadMigrations, backupTo } from '../../../storage/db.mjs';
import { createAuthStore } from '../../../auth/store.mjs';
import { createSyncState } from '../../../sync/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '../../../storage/migrations');
const CREATED_AT = Date.UTC(2026, 10, 27, 12, 0, 0);

const alert = (id, extra = {}) => ({ id, symbol: 'BINANCE:BTCUSDT', condition: 'up', price: 100000, message: 'fixture', active: true, created: CREATED_AT, ...extra });

export function buildFixture(schema, outDir = HERE) {
  const all = loadMigrations(MIGRATIONS);
  if (!Number.isInteger(schema) || schema < 1 || schema > all.length) throw new Error(`schema must be 1..${all.length}`);
  const work = mkdtempSync(path.join(tmpdir(), 'wl-fixture-'));
  const migDir = path.join(work, 'migrations');
  mkdirSync(migDir);
  for (const f of readdirSync(MIGRATIONS).filter((n) => /^\d+_.*\.sql$/.test(n)).sort().slice(0, schema)) copyFileSync(path.join(MIGRATIONS, f), path.join(migDir, f));
  const { db } = openDatabase(path.join(work, 'data'), { migrationsDir: migDir });
  const now = () => CREATED_AT;
  const expect = { schema, createdAt: CREATED_AT };

  // Schema 1: sessions, API tokens, audit log.
  const store = createAuthStore(db, { now });
  expect.session = store.createSession({ userAgent: 'fixture' }).token;
  expect.token = store.createToken('fixture').token;

  if (schema >= 2) { // synced state with history and a tombstone
    const sync = createSyncState(db, { now });
    const w = (key, value, baseVersion) => sync.write(key, { value, baseVersion, epoch: sync.epoch(), clientId: 'fixture' });
    w('watchlist', JSON.stringify(['YAHOO:AAPL', 'BINANCE:BTCUSDT']), 0);
    w('theme', JSON.stringify('dark'), 0);
    w('alerts', JSON.stringify([alert('a1'), alert('a2')]), 0);
    w('alerts', JSON.stringify([alert('a1', { active: false, triggeredAt: CREATED_AT, triggerPrice: 100010 })]), 1);
    w('drawings.YAHOO:AAPL', JSON.stringify([{ id: 'd1', type: 'hline', price: 190 }]), 0);
    w('drawings.YAHOO:AAPL', null, 1);
    expect.epoch = sync.epoch();
    expect.keys = Object.fromEntries(Object.entries(sync.snapshot().keys).map(([k, v]) => [k, { v: v.v, ver: v.ver, deleted: v.deleted }]));
  }
  if (schema >= 3) { // alert records and queued notifications
    db.prepare("INSERT INTO alert_meta (alert_id, last_trigger_key, last_price, last_tick_at, last_session) VALUES ('a1', ?, 100010, ?, 1)").run(`a1:${CREATED_AT}`, CREATED_AT);
    db.prepare("INSERT INTO alert_meta (alert_id, status, tombstoned_at) VALUES ('a2', 'deleted', ?)").run(CREATED_AT);
    db.prepare("INSERT INTO notification_outbox (dedup_key, provider, payload, next_attempt_at, created_at) VALUES (?, 'gotify', ?, ?, ?)")
      .run(`alert:a1:${CREATED_AT}`, JSON.stringify({ title: 'BTCUSDT crossing up 100000', message: 'Now 100010' }), CREATED_AT, CREATED_AT);
  }
  if (schema >= 4) db.prepare("UPDATE alert_meta SET trigger_version = 2 WHERE alert_id = 'a1'").run();

  const file = path.join(outDir, `schema-${schema}.db`);
  rmSync(file, { force: true });
  backupTo(db, file); // VACUUM INTO: one compact file, no WAL
  db.close();
  rmSync(work, { recursive: true, force: true });
  writeFileSync(path.join(outDir, `schema-${schema}.json`), `${JSON.stringify(expect, null, 2)}\n`);
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2]);
  console.log(`fixture written: ${buildFixture(n)}`);
}
