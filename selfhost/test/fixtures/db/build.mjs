// Builds a migration fixture: a database at schema N holding known data, so later releases can prove
// it upgrades to their schema without losing anything (test/unit/migration-fixtures.test.mjs).
//
//   node selfhost/test/fixtures/db/build.mjs <N>      writes schema-<N>.db and schema-<N>.json here
//
// Run it for the current schema when cutting a release that changed the schema (UPSTREAM.md, "Cutting
// a release"), then add the two files to IMMUTABLE. Fixtures are never rebuilt: each one is the
// database an older release really wrote, so this refuses to overwrite one, refuses older schemas
// (today's code would not write what that release wrote), and CI refuses changes to frozen ones.
// The .json holds every row of every table as written, so the test can prove nothing is lost.
// The credentials inside are for this test database only.

import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, loadMigrations, backupTo } from '../../../storage/db.mjs';
import { createAuthStore } from '../../../auth/store.mjs';
import { createSyncState } from '../../../sync/state.mjs';
import { existsSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '../../../storage/migrations');
const CREATED_AT = Date.UTC(2026, 10, 27, 12, 0, 0);

const alert = (id, extra = {}) => ({ id, symbol: 'BINANCE:BTCUSDT', condition: 'up', price: 100000, message: 'fixture', active: true, created: CREATED_AT, ...extra });

/** Every row of every table, ordered by rowid: what the test compares after the migration. */
export function dumpTables(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));
}

export function buildFixture(schema, outDir = HERE, { historical = false } = {}) {
  const all = loadMigrations(MIGRATIONS);
  if (!Number.isInteger(schema) || schema < 1 || schema > all.length) throw new Error(`schema must be 1..${all.length}`);
  if (schema !== all.length && !historical) throw new Error(`only the current schema (${all.length}) can be captured: today's code does not write what an older release wrote`);
  for (const ext of ['db', 'json']) {
    if (existsSync(path.join(outDir, `schema-${schema}.${ext}`))) throw new Error(`schema-${schema}.${ext} exists; fixtures are never rebuilt`);
  }
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
  store.audit('login.ok', { ip: '192.0.2.10' });
  store.audit('login.fail', { ip: '192.0.2.11', detail: { reason: 'password' } });
  store.setTotpCounter(59_000_123);

  if (schema >= 2) { // synced state with history and a tombstone
    const sync = createSyncState(db, { now });
    const w = (key, value, baseVersion) => sync.write(key, { value, baseVersion, epoch: sync.epoch(), clientId: 'fixture' });
    w('watchlist', JSON.stringify(['YAHOO:AAPL', 'BINANCE:BTCUSDT']), 0);
    w('theme', JSON.stringify('dark'), 0);
    w('alerts', JSON.stringify([alert('a1'), alert('a2')]), 0);
    w('alerts', JSON.stringify([alert('a1', { active: false, triggeredAt: CREATED_AT, triggerPrice: 100010 })]), 1);
    w('drawings.YAHOO:AAPL', JSON.stringify([{ id: 'd1', type: 'hline', price: 190 }]), 0);
    w('drawings.YAHOO:AAPL', null, 1);
    w('drawings.YAHOO:MSFT', JSON.stringify([{ id: 'd2', type: 'hline', price: 400 }]), 0);
    w('drawings.YAHOO:MSFT', null, 1);
    expect.cursor = sync.rev(); // a device that saw everything so far
    // A row limit reached: the oldest tombstone is pruned, so pruned_rev is non-zero.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM kv_state').get().n;
    createSyncState(db, { now, maxRows: rows }).write('lang', { value: JSON.stringify('en'), baseVersion: 0, epoch: sync.epoch(), clientId: 'fixture' });
    w('theme', JSON.stringify('light'), 1);
    expect.epoch = sync.epoch();
    expect.prunedRev = sync.prunedRev();
    expect.changesAfterCursor = sync.changesSince(expect.cursor).map((c) => [c.key, c.ver, c.rev]);
    expect.keys = Object.fromEntries(Object.entries(sync.snapshot().keys).map(([k, v]) => [k, { v: v.v, ver: v.ver, deleted: v.deleted }]));
  }
  if (schema >= 3) { // alert records and queued notifications
    db.prepare("INSERT INTO alert_meta (alert_id, last_trigger_key, last_price, last_tick_at, last_session) VALUES ('a1', ?, 100010, ?, 1)").run(`a1:${CREATED_AT}`, CREATED_AT);
    db.prepare("INSERT INTO alert_meta (alert_id, status, tombstoned_at) VALUES ('a2', 'deleted', ?)").run(CREATED_AT);
    const outbox = db.prepare(`INSERT INTO notification_outbox (dedup_key, provider, payload, attempts, next_attempt_at, status, last_error, last_attempt_at, created_at, sent_at)
      VALUES (?, 'gotify', ?, ?, ?, ?, ?, ?, ?, ?)`);
    const payload = (m) => JSON.stringify({ title: 'BTCUSDT crossing up 100000', message: m, url: 'https://w.example/#s=BINANCE%3ABTCUSDT' });
    outbox.run(`alert:a1:${CREATED_AT}`, payload('Now 100010'), 2, CREATED_AT + 20_000, 'pending', 'Gotify answered 503', CREATED_AT + 5_000, CREATED_AT, null);
    outbox.run('alert:a0:1', payload('Now 99990'), 1, CREATED_AT, 'sent', null, CREATED_AT, CREATED_AT - 60_000, CREATED_AT);
    outbox.run('stale:YAHOO:AAPL:1', payload('No prices'), 8, CREATED_AT, 'failed', 'Gotify answered 401', CREATED_AT, CREATED_AT - 3_600_000, null);
  }
  if (schema >= 4) db.prepare("UPDATE alert_meta SET trigger_version = 2 WHERE alert_id = 'a1'").run();

  expect.tables = dumpTables(db);
  const file = path.join(outDir, `schema-${schema}.db`);
  backupTo(db, file); // VACUUM INTO: one compact file, no WAL
  db.close();
  rmSync(work, { recursive: true, force: true });
  writeFileSync(path.join(outDir, `schema-${schema}.json`), `${JSON.stringify(expect, null, 2)}\n`);
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2]);
  console.log(`fixture written: ${buildFixture(n, HERE, { historical: process.argv.includes('--historical') })}`);
}
