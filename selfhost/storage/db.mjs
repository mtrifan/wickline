// SQLite access for the self-hosted edition (ADR-005: built-in node:sqlite, isolated here so the
// driver can be swapped for better-sqlite3 if the experimental API changes).
//
// Migrations are numbered SQL files in ./migrations, tracked with PRAGMA user_version. Pending
// migrations run in one transaction each, after an automatic backup of an existing database.
// A database newer than this code (a downgrade) is refused with rollback instructions.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export class DowngradeError extends Error {}

/** Migration files as [{ version, name, sql }], sorted; names must be NNN_description.sql. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((f, i) => {
    const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f);
    if (!m || Number(m[1]) !== i + 1) throw new Error(`Migration ${f}: expected ${String(i + 1).padStart(3, '0')}_<name>.sql`);
    return { version: i + 1, name: f, sql: readFileSync(path.join(dir, f), 'utf8') };
  });
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** Consistent copy of a live database (works while it is open, WAL included). */
export function backupTo(db, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

/**
 * Opens (and creates) <dataDir>/wickline.db and applies pending migrations.
 * Returns { db, file, version, migrated: [names], backup: path|null }.
 */
export function openDatabase(dataDir, { migrationsDir = MIGRATIONS_DIR, log } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'wickline.db');
  const existed = existsSync(file) && statSync(file).size > 0;
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');

  const migrations = loadMigrations(migrationsDir);
  const known = migrations.length;
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > known) {
    db.close();
    throw new DowngradeError(
      `The database at ${file} has schema version ${current}, but this version of Wickline Self-Hosted only knows ${known}. `
      + 'It was written by a newer release. Run that release again, or restore the backup taken before the upgrade '
      + '(see UPGRADE.md: "Roll back").',
    );
  }

  const pending = migrations.filter((m) => m.version > current);
  let backup = null;
  if (pending.length && existed && current > 0) {
    backup = backupTo(db, path.join(dataDir, 'backups', `pre-migrate-${current}-to-${known}-${stamp()}.db`));
    log?.info('database backed up before migration', { backup, from: current, to: known });
  }
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      log?.info('database migration applied', { migration: m.name });
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw new Error(`Migration ${m.name} failed: ${e.message}`);
    }
  }
  return { db, file, version: known, migrated: pending.map((m) => m.name), backup };
}

/** Runs fn inside a transaction (synchronous, as node:sqlite is). */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
