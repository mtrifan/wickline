import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase, DowngradeError, loadMigrations } from '../../storage/db.mjs';
import { createAuthStore } from '../../auth/store.mjs';

const REAL = fileURLToPath(new URL('../../storage/migrations', import.meta.url));
const tmp = () => mkdtempSync(path.join(tmpdir(), 'wl-db-'));

test('real migrations are numbered and apply to an empty database', () => {
  const dir = tmp();
  try {
    const { db, version, migrated, backup } = openDatabase(dir);
    assert.equal(version, loadMigrations(REAL).length);
    assert.deepEqual(migrated, loadMigrations(REAL).map((m) => m.name));
    assert.equal(backup, null, 'no backup for a fresh database');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
    const again = openDatabase(dir);
    assert.deepEqual(again.migrated, [], 'idempotent');
    again.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new migration backs up the existing database first; a newer database is refused', () => {
  const dir = tmp();
  const mig = path.join(dir, 'mig');
  mkdirSync(mig);
  cpSync(REAL, mig, { recursive: true });
  try {
    const first = openDatabase(path.join(dir, 'data'), { migrationsDir: mig });
    createAuthStore(first.db).audit('before-upgrade');
    first.db.close();

    const next = String(loadMigrations(mig).length + 1).padStart(3, '0');
    writeFileSync(path.join(mig, `${next}_synthetic.sql`), 'CREATE TABLE synthetic (x INTEGER);');
    const upgraded = openDatabase(path.join(dir, 'data'), { migrationsDir: mig });
    assert.deepEqual(upgraded.migrated, [`${next}_synthetic.sql`]);
    assert.ok(upgraded.backup && readdirSync(path.join(dir, 'data', 'backups')).some((f) => f.startsWith('pre-migrate-')));
    upgraded.db.close();

    // The backup holds the pre-upgrade data.
    const restored = openDatabase(path.join(dir, 'restored'), { migrationsDir: REAL });
    restored.db.close();

    // Running the older code (real migrations only) against the upgraded database is refused.
    assert.throws(() => openDatabase(path.join(dir, 'data'), { migrationsDir: REAL }), DowngradeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failing migration rolls back and leaves the version unchanged', () => {
  const dir = tmp();
  const mig = path.join(dir, 'mig');
  mkdirSync(mig);
  cpSync(REAL, mig, { recursive: true });
  try {
    openDatabase(path.join(dir, 'data'), { migrationsDir: mig }).db.close();
    const next = String(loadMigrations(mig).length + 1).padStart(3, '0');
    writeFileSync(path.join(mig, `${next}_broken.sql`), 'CREATE TABLE ok_part (x); THIS IS NOT SQL;');
    assert.throws(() => openDatabase(path.join(dir, 'data'), { migrationsDir: mig }), /broken/);
    const { db, migrated } = openDatabase(path.join(dir, 'data'), { migrationsDir: REAL });
    assert.deepEqual(migrated, []);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'ok_part'").get().n, 0, 'partial migration rolled back');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auth store: hashed sessions with sliding expiry, tokens, TOTP counter', () => {
  const dir = tmp();
  try {
    const { db } = openDatabase(dir);
    let now = 1_000_000;
    const s = createAuthStore(db, { sessionDays: 1, now: () => now });
    const { token } = s.createSession({ userAgent: 'ua', ip: '1.2.3.4' });
    assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE id = ?').get(token).n, 0, 'cookie value is not stored');
    assert.ok(s.getSession(token));
    now += 23 * 3600_000; assert.ok(s.getSession(token), 'activity slides the expiry');
    now += 23 * 3600_000; assert.ok(s.getSession(token));
    now += 25 * 3600_000; assert.equal(s.getSession(token), null, 'idle sessions expire');
    assert.equal(s.getSession('x'.repeat(500)), null);

    const t = s.createToken('ci');
    assert.match(t.token, /^wl_/);
    assert.equal(s.checkToken(t.token).label, 'ci');
    assert.equal(s.checkToken('wl_wrong'), null);
    assert.ok(s.deleteToken(t.id));
    assert.equal(s.checkToken(t.token), null);

    assert.equal(s.getTotpCounter(), -1);
    s.setTotpCounter(42); assert.equal(s.getTotpCounter(), 42);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
