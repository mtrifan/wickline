// Migration fixtures (PLAN §6 "Migrations"): a database written by each schema version upgrades to
// the current schema with every piece of data intact, and is backed up first. The fixtures are built
// once per schema by test/fixtures/db/build.mjs, listed in IMMUTABLE, and never rebuilt (CI refuses
// changes to listed files).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, loadMigrations } from '../../storage/db.mjs';
import { createAuthStore } from '../../auth/store.mjs';
import { createSyncState } from '../../sync/state.mjs';
import { createAlertLedger } from '../../alerts/ledger.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/db');
const HEAD = loadMigrations().length;
const fixtures = readdirSync(DIR).filter((f) => /^schema-\d+\.db$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b);
const frozen = readFileSync(path.join(DIR, 'IMMUTABLE'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('there is a fixture for every schema, the current one included', () => {
  assert.deepEqual(fixtures, Array.from({ length: HEAD }, (_, i) => i + 1),
    `missing fixture: run "node selfhost/test/fixtures/db/build.mjs ${HEAD}" (UPSTREAM.md, "Cutting a release")`);
});

test('every fixture is frozen in IMMUTABLE, so CI refuses changes to it', () => {
  for (const n of fixtures) {
    for (const f of [`schema-${n}.db`, `schema-${n}.json`]) assert.ok(frozen.includes(f), `${f} is not listed in test/fixtures/db/IMMUTABLE`);
  }
});

for (const n of fixtures) {
  test(`a schema-${n} database upgrades to schema ${HEAD} with its data intact`, () => {
    const expect = JSON.parse(readFileSync(path.join(DIR, `schema-${n}.json`), 'utf8'));
    const dir = mkdtempSync(path.join(tmpdir(), `wl-fixture-${n}-`));
    dirs.push(dir);
    copyFileSync(path.join(DIR, `schema-${n}.db`), path.join(dir, 'wickline.db'));
    const { db, version, migrated, backup } = openDatabase(dir);
    assert.equal(version, HEAD);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, HEAD);
    assert.equal(migrated.length, HEAD - n);
    if (n < HEAD) assert.ok(backup && existsSync(backup), 'backed up before migrating');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

    // Nothing lost: every row and column the old release wrote is still there, unchanged (checked
    // before anything below writes). Columns added by later migrations are not part of the record.
    // Later migrations may add rows (meta keys) but never change or drop one.
    for (const [table, rows] of Object.entries(expect.tables)) {
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const now = new Set(db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).all().map((r) => JSON.stringify({ ...r })));
      for (const row of rows) assert.ok(now.has(JSON.stringify(row)), `table ${table}: row lost or changed: ${JSON.stringify(row).slice(0, 200)}`);
    }

    // And it still works. Logins (at the fixture's own time: sessions expire) and two-factor replay
    // protection.
    const store = createAuthStore(db, { now: () => expect.createdAt });
    assert.equal(store.getTotpCounter(), 59_000_123);
    assert.ok(store.getSession(expect.session), 'the session still works');
    assert.ok(store.checkToken(expect.token), 'the API token still works');

    if (n >= 2) { // sync: epoch, revisions and the pruning watermark, so devices resume correctly
      const sync = createSyncState(db);
      assert.equal(sync.epoch(), expect.epoch);
      assert.ok(expect.prunedRev > 0);
      assert.equal(sync.prunedRev(), expect.prunedRev);
      assert.deepEqual(sync.changesSince(expect.cursor).map((c) => [c.key, c.ver, c.rev]), expect.changesAfterCursor,
        'a device resuming from its cursor gets exactly what it missed');
      // A device still on the alerts base version 1 can merge (the history survived).
      const added = { id: 'n1', symbol: 'YAHOO:AAPL', condition: 'up', price: 1, message: '', active: true, created: 1 };
      const base = db.prepare("SELECT value FROM kv_history WHERE key = 'alerts' AND version = 1").get().value;
      const r = sync.write('alerts', { value: JSON.stringify([added, ...JSON.parse(base)]), baseVersion: 1, epoch: sync.epoch() });
      assert.equal(r.changed, true);
      assert.deepEqual(JSON.parse(sync.snapshot().keys.alerts.v).map((a) => a.id).sort(), ['a1', 'n1'], 'merged onto the current value');
    }
    if (n >= 3) { // alert records, read through the code that uses them
      const ledger = createAlertLedger(db, { now: () => expect.createdAt });
      assert.equal(ledger.lastTriggerAt('a1'), expect.createdAt);
      assert.equal(ledger.isTombstoned('a2'), true);
      assert.deepEqual(ledger.resumePoints().a1, { price: 100010, at: expect.createdAt, session: 1 });
      if (n >= 4) assert.deepEqual(ledger.lastTrigger('a1'), { at: expect.createdAt, version: 2 });
    }
    db.close();
  });
}
