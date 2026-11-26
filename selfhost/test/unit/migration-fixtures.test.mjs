// Migration fixtures (PLAN §6 "Migrations"): a database written by each schema version upgrades to
// the current schema with every piece of data intact, and is backed up first. The fixtures are built
// once per schema by test/fixtures/db/build.mjs and never rebuilt.
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
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('there is a fixture for every schema, the current one included', () => {
  assert.deepEqual(fixtures, Array.from({ length: HEAD }, (_, i) => i + 1),
    `missing fixture: run "node selfhost/test/fixtures/db/build.mjs ${HEAD}" (UPSTREAM.md, "Cutting a release")`);
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

    // Logins survive (checked at the fixture's own time: sessions expire).
    const store = createAuthStore(db, { now: () => expect.createdAt });
    assert.ok(store.getSession(expect.session), 'the session still works');
    assert.ok(store.checkToken(expect.token), 'the API token still works');

    if (n >= 2) { // synced state: values, versions, tombstones and the epoch
      const sync = createSyncState(db);
      const snap = sync.snapshot();
      assert.equal(snap.epoch, expect.epoch);
      for (const [k, v] of Object.entries(expect.keys)) assert.deepEqual({ v: snap.keys[k].v, ver: snap.keys[k].ver, deleted: snap.keys[k].deleted }, v, k);
      // A device still on the alerts base version 1 can merge (the history survived).
      const added = { id: 'n1', symbol: 'YAHOO:AAPL', condition: 'up', price: 1, message: '', active: true, created: 1 };
      const r = sync.write('alerts', { value: JSON.stringify([added, ...JSON.parse(readFirstAlerts(db))]), baseVersion: 1, epoch: snap.epoch });
      assert.equal(r.changed, true);
      assert.deepEqual(JSON.parse(sync.snapshot().keys.alerts.v).map((a) => a.id).sort(), ['a1', 'n1'], 'merged onto the current value');
    }
    if (n >= 3) { // alert records and queued notifications
      const ledger = createAlertLedger(db, { now: () => expect.createdAt });
      assert.equal(ledger.lastTriggerAt('a1'), expect.createdAt);
      assert.equal(ledger.isTombstoned('a2'), true);
      assert.deepEqual(ledger.resumePoints().a1, { price: 100010, at: expect.createdAt, session: 1 });
      const row = db.prepare("SELECT dedup_key, status FROM notification_outbox WHERE provider = 'gotify'").get();
      assert.deepEqual({ ...row }, { dedup_key: `alert:a1:${expect.createdAt}`, status: 'pending' });
    }
    db.close();
  });
}

/** The alerts value at version 1, as the device in the test still has it. */
function readFirstAlerts(db) {
  return db.prepare("SELECT value FROM kv_history WHERE key = 'alerts' AND version = 1").get().value;
}
