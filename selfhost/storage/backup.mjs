// Backups and restore (PLAN §2.4): scheduled VACUUM INTO copies, a server lock so a restore never
// swaps the database under a running server, and the restore itself.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { backupTo, loadMigrations } from './db.mjs';

const SCHEDULED = /^wickline-\d{8}-\d{6}(-[0-9a-f]{4})?\.db$/;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export const backupDir = (dataDir) => path.join(dataDir, 'backups');

/** Scheduled backups, newest first: [{ file, name, mtimeMs }]. Pre-migration and pre-restore copies are not listed. */
export function listBackups(dataDir) {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => SCHEDULED.test(n))
    .map((name) => ({ name, file: path.join(dir, name), mtimeMs: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Writes backups/wickline-<time>.db and keeps the newest `keep`. Returns the new file. */
export function runBackup(db, dataDir, { keep = 14, now = new Date() } = {}) {
  let file = path.join(backupDir(dataDir), `wickline-${stamp(now)}.db`);
  if (existsSync(file)) file = file.replace(/\.db$/, `-${randomBytes(2).toString('hex')}.db`); // two in one second
  backupTo(db, file);
  for (const old of listBackups(dataDir).slice(keep)) rmSync(old.file, { force: true });
  return file;
}

/**
 * Runs a backup every `intervalHours` (0 disables). After a restart the schedule continues from
 * the newest backup, so a frequently restarted container still gets one per interval.
 */
export function startBackupScheduler({ db, dataDir, intervalHours = 24, keep = 14, log, firstDelayMs = 60_000 }) {
  if (!intervalHours) return { stop() {} };
  const interval = intervalHours * 3600_000;
  let timer = null;
  const run = () => {
    try {
      const file = runBackup(db, dataDir, { keep });
      log?.info('backup written', { file });
    } catch (e) {
      log?.error('backup failed', { error: e });
    }
    timer = setTimeout(run, interval);
    timer.unref();
  };
  const newest = listBackups(dataDir)[0];
  const due = newest ? Math.max(newest.mtimeMs + interval - Date.now(), firstDelayMs) : firstDelayMs;
  timer = setTimeout(run, due);
  timer.unref();
  return { stop() { clearTimeout(timer); } };
}

// --- server lock -------------------------------------------------------------------------------

const LOCK = 'server.lock';
/** A lock refreshed more recently than this belongs to a running server. */
export const LOCK_STALE_MS = 90_000;

/** Marks the data directory as in use; the lock is refreshed every 30 s and removed on stop. */
export function holdServerLock(dataDir) {
  const file = path.join(dataDir, LOCK);
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const timer = setInterval(() => { try { const t = new Date(); utimesSync(file, t, t); } catch { /* removed */ } }, 30_000);
  timer.unref();
  return { release() { clearInterval(timer); rmSync(file, { force: true }); } };
}

/** The running server's lock, or null (none, or stale after an unclean stop). */
export function activeServerLock(dataDir, now = Date.now()) {
  const file = path.join(dataDir, LOCK);
  if (!existsSync(file)) return null;
  const age = now - statSync(file).mtimeMs;
  if (age > LOCK_STALE_MS) return null;
  try { return { ...JSON.parse(readFileSync(file, 'utf8')), ageMs: age }; } catch { return { ageMs: age }; }
}

// --- restore -----------------------------------------------------------------------------------

export class RestoreError extends Error {}

/** Checks that `file` is an intact Wickline database this code can open; returns its schema version. */
export function inspectBackup(file, { migrationsDir } = {}) {
  if (!existsSync(file)) throw new RestoreError(`No such file: ${file}`);
  let src;
  try { src = new DatabaseSync(file, { readOnly: true }); } catch (e) { throw new RestoreError(`Not a database: ${e.message}`); }
  try {
    let ok;
    try { ok = src.prepare('PRAGMA integrity_check').get(); } catch (e) { throw new RestoreError(`Not a database: ${e.message}`); }
    if (Object.values(ok)[0] !== 'ok') throw new RestoreError(`The backup is damaged (integrity check: ${Object.values(ok)[0]})`);
    const version = src.prepare('PRAGMA user_version').get().user_version;
    const hasMeta = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (version < 1 || !hasMeta) throw new RestoreError('This is not a Wickline Self-Hosted database');
    const known = loadMigrations(migrationsDir).length;
    if (version > known) {
      throw new RestoreError(`The backup has schema version ${version}, newer than this release (${known}). Restore it with the release that wrote it.`);
    }
    return { version, known };
  } finally { src.close(); }
}

/**
 * Replaces <dataDir>/wickline.db with `file`. The server must be stopped (its lock is checked).
 * The current database is first saved as backups/pre-restore-<time>.db. The restored copy gets a
 * new epoch, so browsers holding newer data re-hydrate from it instead of writing that data back.
 *
 * Credentials never go back in time: the copy's sessions are cleared (every browser signs in
 * again), its API tokens are replaced by the live database's current ones (a token revoked since
 * the backup stays revoked), and the TOTP replay counter keeps the higher of the two values.
 * Returns { version, saved, epoch, tokens }.
 */
export function restoreDatabase(dataDir, file, { force = false, migrationsDir } = {}) {
  const lock = activeServerLock(dataDir);
  if (lock && !force) {
    throw new RestoreError('Wickline Self-Hosted is running on this data directory. Stop the container first (or pass --force if you are sure it is not running).');
  }
  const source = path.resolve(file);
  const live = path.join(dataDir, 'wickline.db');
  if (source === path.resolve(live)) throw new RestoreError('That is the live database itself; pick a backup file');
  const { version } = inspectBackup(source, { migrationsDir });

  mkdirSync(backupDir(dataDir), { recursive: true });
  let saved = null;
  let current = null; // the live credentials: { tokens, totpCounter }
  if (existsSync(live)) {
    const cur = new DatabaseSync(live);
    try {
      saved = backupTo(cur, path.join(backupDir(dataDir), `pre-restore-${stamp()}.db`));
      const has = (t) => cur.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      current = {
        tokens: has('api_tokens') ? cur.prepare('SELECT id, hash, label, created_at, last_used_at FROM api_tokens').all() : [],
        totpCounter: has('meta') ? Number(cur.prepare("SELECT value FROM meta WHERE key = 'totp_last_counter'").get()?.value ?? -1) : -1,
      };
    } finally { cur.close(); }
  }

  // Copy through VACUUM INTO (a consistent single file, whatever WAL the backup had), set the new
  // epoch in the copy, then swap it in with a rename.
  const tmp = path.join(dataDir, `wickline.db.restore-${randomBytes(4).toString('hex')}`);
  const src = new DatabaseSync(source, { readOnly: true });
  try { src.prepare('VACUUM INTO ?').run(tmp); } finally { src.close(); }
  const epoch = randomBytes(8).toString('hex');
  const copy = new DatabaseSync(tmp);
  let tokens;
  try {
    copy.exec('BEGIN');
    // Before schema 2 there is no epoch yet; migration 002 creates a random one on the next start.
    copy.prepare("UPDATE meta SET value = ? WHERE key = 'epoch'").run(epoch);
    copy.exec('DELETE FROM sessions');
    if (current) {
      copy.exec('DELETE FROM api_tokens');
      const add = copy.prepare('INSERT INTO api_tokens (id, hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)');
      for (const t of current.tokens) add.run(t.id, t.hash, t.label, t.created_at, t.last_used_at);
      const restored = Number(copy.prepare("SELECT value FROM meta WHERE key = 'totp_last_counter'").get()?.value ?? -1);
      const counter = Math.max(restored, current.totpCounter);
      if (counter >= 0) copy.prepare("INSERT INTO meta (key, value) VALUES ('totp_last_counter', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(counter));
    }
    tokens = copy.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n;
    copy.prepare("INSERT INTO audit_log (at, event, detail) VALUES (?, 'restore', ?)").run(Date.now(), JSON.stringify({ from: path.basename(source), tokensFromLive: !!current }));
    copy.exec('COMMIT');
  } catch (e) {
    try { copy.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    copy.close();
    rmSync(tmp, { force: true });
    throw e;
  }
  copy.close();
  for (const ext of ['-wal', '-shm']) rmSync(live + ext, { force: true });
  renameSync(tmp, live);
  return { version, saved, epoch: version >= 2 ? epoch : null, tokens, tokensFromLive: !!current };
}
