// Backups, the server lock and restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, readdirSync, existsSync, utimesSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, loadMigrations } from '../../storage/db.mjs';

const SCHEMA = loadMigrations().length; // the current schema version
const AFTER_PHASE_1 = loadMigrations().slice(1).map((m) => m.name); // what a Phase 1 database runs
import { runBackup, listBackups, startBackupScheduler, holdServerLock, activeServerLock, inspectBackup, restoreDatabase, RestoreError, sweepTemporaryFiles, DataDirInUseError } from '../../storage/backup.mjs';
import { createSyncState } from '../../sync/state.mjs';

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-backup-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const keysOf = (dir) => { const { db } = openDatabase(dir); try { return createSyncState(db).exportKeys(); } finally { db.close(); } };
const epochOf = (dir) => { const { db } = openDatabase(dir); try { return createSyncState(db).epoch(); } finally { db.close(); } };

test('runBackup writes a consistent copy and keeps only the newest N scheduled backups', () => withDir((dir) => {
  const { db } = openDatabase(dir);
  const st = createSyncState(db);
  st.write('theme', { value: 'dark', baseVersion: 0, epoch: st.epoch() });
  mkdirSync(path.join(dir, 'backups'), { recursive: true });
  writeFileSync(path.join(dir, 'backups', 'pre-migrate-1-to-2-x.db'), ''); // never pruned
  for (let i = 0; i < 5; i++) runBackup(db, dir, { keep: 3, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  runBackup(db, dir, { keep: 3, now: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)) }); // same second: suffixed
  db.close();
  const names = listBackups(dir).map((b) => b.name);
  assert.equal(names.length, 3);
  assert.match(names[0], /^wickline-20260101-000004-[0-9a-f]{4}\.db$/, 'the same-second copy is the newest');
  assert.equal(names[1], 'wickline-20260101-000004.db');
  assert.ok(readdirSync(path.join(dir, 'backups')).includes('pre-migrate-1-to-2-x.db'));
  const copy = new DatabaseSync(listBackups(dir)[0].file, { readOnly: true });
  assert.equal(copy.prepare("SELECT value FROM kv_state WHERE key = 'theme'").get().value, 'dark');
  copy.close();
}));

test('the scheduler writes backups on its interval and can be stopped', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-backup-'));
  const { db } = openDatabase(dir);
  const s = startBackupScheduler({ db, dataDir: dir, intervalHours: 0.2 / 3600, keep: 10, firstDelayMs: 20 });
  await new Promise((r) => setTimeout(r, 700));
  s.stop();
  const n = listBackups(dir).length;
  assert.ok(n >= 2, `expected repeated backups, got ${n}`);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(listBackups(dir).length, n, 'stopped');
  assert.equal(typeof startBackupScheduler({ db, dataDir: dir, intervalHours: 0 }).stop, 'function', 'interval 0 disables');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the server lock is active while held and fresh, and stale after an unclean stop', () => withDir((dir) => {
  assert.equal(activeServerLock(dir), null);
  const lock = holdServerLock(dir);
  assert.equal(activeServerLock(dir).pid, process.pid);
  const old = new Date(Date.now() - 120_000);
  utimesSync(path.join(dir, 'server.lock'), old, old);
  assert.equal(activeServerLock(dir), null, 'stale');
  lock.release();
  assert.equal(existsSync(path.join(dir, 'server.lock')), false);
}));

test('restore replaces the database, saves the previous one and starts a new epoch', () => withDir((root) => {
  const dir = path.join(root, 'data');
  const { db } = openDatabase(dir);
  const st = createSyncState(db);
  st.write('watchlist', { value: '["AAPL"]', baseVersion: 0, epoch: st.epoch() });
  const backup = runBackup(db, dir);
  st.write('watchlist', { value: '["MSFT"]', baseVersion: 1, epoch: st.epoch() });
  st.write('theme', { value: 'light', baseVersion: 0, epoch: st.epoch() });
  const before = st.epoch();
  db.close();

  const r = restoreDatabase(dir, backup);
  assert.equal(r.version, SCHEMA);
  assert.match(r.saved, /backups\/pre-restore-\d{8}-\d{6}\.db$/);
  assert.deepEqual(keysOf(dir), { watchlist: '["AAPL"]' });
  assert.notEqual(epochOf(dir), before);
  assert.equal(epochOf(dir), r.epoch);
  const saved = new DatabaseSync(r.saved, { readOnly: true });
  assert.equal(saved.prepare("SELECT value FROM kv_state WHERE key = 'theme'").get().value, 'light');
  saved.close();
}));

test('restore refuses a running server, damaged or foreign files, newer schemas and the live file', () => withDir((root) => {
  const dir = path.join(root, 'data');
  const { db } = openDatabase(dir);
  const good = runBackup(db, dir);
  db.close();
  const refused = (fn, re) => assert.throws(fn, (e) => e instanceof RestoreError && re.test(e.message));

  const lock = holdServerLock(dir);
  refused(() => restoreDatabase(dir, good), /is running/);
  assert.equal(restoreDatabase(dir, good, { force: true }).version, SCHEMA, '--force overrides');
  lock.release();

  const garbage = path.join(root, 'garbage.db');
  writeFileSync(garbage, 'this is not sqlite'.repeat(100));
  refused(() => restoreDatabase(dir, garbage), /Not a database|damaged/);
  const foreign = path.join(root, 'foreign.db');
  new DatabaseSync(foreign).exec('CREATE TABLE x (y)');
  refused(() => restoreDatabase(dir, foreign), /not a Wickline/);
  const newer = path.join(root, 'newer.db');
  copyFileSync(good, newer);
  const n = new DatabaseSync(newer); n.exec('PRAGMA user_version = 99'); n.close();
  refused(() => restoreDatabase(dir, newer), /newer than this release/);
  refused(() => restoreDatabase(dir, path.join(dir, 'wickline.db')), /live database/);
  refused(() => restoreDatabase(dir, path.join(root, 'missing.db')), /No such file/);
  assert.equal(inspectBackup(good).version, SCHEMA);
}));

test('a Phase 1 backup restores and is migrated on the next start', () => withDir((root) => {
  const mig = path.join(root, 'mig');
  mkdirSync(mig);
  writeFileSync(path.join(mig, '001_auth.sql'), readFileSync(new URL('../../storage/migrations/001_auth.sql', import.meta.url)));
  const p1 = path.join(root, 'p1');
  openDatabase(p1, { migrationsDir: mig }).db.close();
  const dir = path.join(root, 'data');
  openDatabase(dir).db.close();
  const r = restoreDatabase(dir, path.join(p1, 'wickline.db'));
  assert.deepEqual([r.version, r.epoch], [1, null]);
  const { migrated, db } = openDatabase(dir);
  assert.deepEqual(migrated, AFTER_PHASE_1);
  db.close();
}));

test('restore never brings back revoked credentials or a used TOTP code', () => withDir((root) => {
  const dir = path.join(root, 'data');
  const { db } = openDatabase(dir);
  db.prepare('INSERT INTO sessions (id, created_at, last_seen_at, expires_at) VALUES (?, 0, 0, ?)').run('old-session', Date.now() + 1e9);
  db.prepare("INSERT INTO api_tokens (id, hash, label, created_at) VALUES ('t-revoked', 'h1', 'revoked later', 0)").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('totp_last_counter', '100')").run();
  const backup = runBackup(db, dir);
  // after the backup: the token is revoked, a new one is created, more TOTP codes are used
  db.prepare("DELETE FROM api_tokens WHERE id = 't-revoked'").run();
  db.prepare("INSERT INTO api_tokens (id, hash, label, created_at) VALUES ('t-new', 'h2', 'created later', 1)").run();
  db.prepare("UPDATE meta SET value = '250' WHERE key = 'totp_last_counter'").run();
  db.close();

  const r = restoreDatabase(dir, backup);
  assert.deepEqual([r.tokens, r.tokensFromLive], [1, true]);
  const check = new DatabaseSync(path.join(dir, 'wickline.db'), { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  assert.deepEqual(check.prepare('SELECT id FROM api_tokens').all().map((t) => t.id), ['t-new']);
  assert.ok(Number(check.prepare("SELECT value FROM meta WHERE key = 'totp_last_counter'").get().value) >= Math.floor(Date.now() / 30_000), 'no earlier code can be replayed');
  assert.equal(check.prepare("SELECT event FROM audit_log ORDER BY id DESC LIMIT 1").get().event, 'restore');
  check.close();
}));

test('with BACKUP_KEEP=1 a same-second backup keeps the one just written', () => withDir((dir) => {
  const { db } = openDatabase(dir);
  const when = new Date(Date.UTC(2026, 0, 1));
  runBackup(db, dir, { keep: 1, now: when });
  const second = runBackup(db, dir, { keep: 1, now: when });
  db.close();
  assert.deepEqual(listBackups(dir).map((b) => b.file), [second]);
}));

test('restore works over a corrupt live database and keeps its raw files', () => withDir((root) => {
  const dir = path.join(root, 'data');
  const { db } = openDatabase(dir);
  const st = createSyncState(db);
  st.write('watchlist', { value: '["GOOD"]', baseVersion: 0, epoch: st.epoch() });
  db.prepare("INSERT INTO api_tokens (id, hash, label, created_at) VALUES ('t-old', 'h', 'x', 0)").run();
  const good = runBackup(db, dir);
  db.close();
  writeFileSync(path.join(dir, 'wickline.db'), 'garbage, not a database'.repeat(200));
  const r = restoreDatabase(dir, good);
  assert.match(r.saved, /pre-restore-\d{8}-\d{6}-raw\.db$/);
  assert.match(readFileSync(r.saved, 'utf8'), /^garbage/);
  assert.equal(r.tokensFromLive, false);
  assert.equal(r.liveDamaged, true);
  assert.equal(r.tokens, 0, 'which tokens were revoked is unknown: none are kept');
  assert.deepEqual(keysOf(dir), { watchlist: '["GOOD"]' });
}));

test('restore folds the live WAL in before the swap and leaves no stale WAL next to the new file', () => withDir((root) => {
  const dir = path.join(root, 'data');
  const { db } = openDatabase(dir);
  const st = createSyncState(db);
  st.write('watchlist', { value: '["BACKUP"]', baseVersion: 0, epoch: st.epoch() });
  const good = runBackup(db, dir);
  st.write('watchlist', { value: '["IN-WAL"]', baseVersion: 1, epoch: st.epoch() }); // stays in the WAL
  // simulate an unclean stop: copy the files while the connection still holds the WAL
  const crashed = path.join(root, 'crashed');
  mkdirSync(crashed);
  for (const ext of ['', '-wal', '-shm']) if (existsSync(path.join(dir, 'wickline.db' + ext))) copyFileSync(path.join(dir, 'wickline.db' + ext), path.join(crashed, 'wickline.db' + ext));
  db.close();
  assert.ok(existsSync(path.join(crashed, 'wickline.db-wal')));
  const r = restoreDatabase(crashed, good);
  const saved = new DatabaseSync(r.saved, { readOnly: true });
  assert.equal(saved.prepare("SELECT value FROM kv_state WHERE key = 'watchlist'").get().value, '["IN-WAL"]', 'the saved copy includes the WAL');
  saved.close();
  assert.deepEqual(readdirSync(crashed).filter((n) => /-wal$|-shm$|\.old-/.test(n)), []);
  assert.deepEqual(keysOf(crashed), { watchlist: '["BACKUP"]' });
}));

test('startup sweeps temporary files from interrupted downloads and restores, but not fresh ones', () => withDir((dir) => {
  mkdirSync(path.join(dir, 'backups'), { recursive: true });
  const files = [path.join(dir, 'backups', '.download-abc123.db'), path.join(dir, 'wickline.db.restore-deadbeef'), path.join(dir, 'wickline.db.old-0011aabb-wal')];
  for (const f of files) writeFileSync(f, 'x');
  const keep = [path.join(dir, 'backups', '.download-fresh01.db'), path.join(dir, 'backups', 'wickline-20260101-000000.db'), path.join(dir, 'wickline.db')];
  for (const f of keep) writeFileSync(f, 'x');
  const old = new Date(Date.now() - 3600_000);
  for (const f of [...files, keep[1], keep[2]]) utimesSync(f, old, old);
  assert.deepEqual(sweepTemporaryFiles(dir).sort(), files.sort());
  for (const f of keep) assert.ok(existsSync(f), f);
}));

test('import skips keys that are device-local on this server and writes the epoch with the data', () => withDir((dir) => {
  const { db } = openDatabase(dir);
  const st = createSyncState(db, { syncWorkspace: false });
  let seen = null;
  st.onEpoch((e) => { seen = { e, stored: db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get().value, rows: st.exportKeys() }; });
  const r = st.replaceAll({ workspace: '{"layout":1}', watchlist: '["X"]' });
  assert.deepEqual(r.skipped, ['workspace']);
  assert.equal(r.keys, 1);
  assert.deepEqual(seen, { e: r.epoch, stored: r.epoch, rows: { watchlist: '["X"]' } }, 'listeners run after both are committed');
  db.close();
}));

test('the sweep skips dangling links instead of failing startup', () => withDir((dir) => {
  mkdirSync(path.join(dir, 'backups'), { recursive: true });
  symlinkSync(path.join(dir, 'missing'), path.join(dir, 'backups', '.download-dead01.db'));
  assert.deepEqual(sweepTemporaryFiles(dir), []);
}));

test('the data-directory lock: another container or a live process is refused; a dead holder or a stale lock is taken over', () => withDir((dir) => {
  const first = holdServerLock(dir, { host: 'container-a', pid: 100, isAlive: () => true });
  assert.throws(() => holdServerLock(dir, { host: 'container-b', pid: 1 }), (e) => e instanceof DataDirInUseError && /host container-a/.test(e.message));
  assert.throws(() => holdServerLock(dir, { host: 'container-a', pid: 200, isAlive: () => true }), (e) => e instanceof DataDirInUseError && /process 100 on this host/.test(e.message));
  // the same container after a crash: the old process is gone (or its PID is reused by the new one)
  holdServerLock(dir, { host: 'container-a', pid: 300, isAlive: () => false });
  assert.equal(activeServerLock(dir).pid, 300);
  holdServerLock(dir, { host: 'container-a', pid: 300, isAlive: () => true });
  // a stale lock from another container (stopped uncleanly more than 90 s ago)
  const old = new Date(Date.now() - 120_000);
  utimesSync(path.join(dir, 'server.lock'), old, old);
  const b = holdServerLock(dir, { host: 'container-b', pid: 1 });
  assert.equal(activeServerLock(dir).host, 'container-b');
  first.release(); // taken over: must not remove container-b's lock
  assert.equal(activeServerLock(dir).host, 'container-b');
  b.release();
  assert.equal(existsSync(path.join(dir, 'server.lock')), false);
}));
