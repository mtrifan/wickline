// Synced state: key policies, the id-array three-way merge, and the SQLite-backed state store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../storage/db.mjs';
import { policyFor, isSynced, isValidKey } from '../../sync/key-policy.mjs';
import { parseIdArray, mergeIdArrays } from '../../sync/merge.mjs';
import { createSyncState, SyncError, HISTORY_DEPTH } from '../../sync/state.mjs';

function withState(opts, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-sync-'));
  const { db } = openDatabase(dir);
  try { return fn(createSyncState(db, opts), db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

const refused = (fn, status, error) => assert.throws(fn, (e) => e instanceof SyncError && e.status === status && e.body.error === error);

// --- key policy --------------------------------------------------------------------------------

test('key policy follows key-classes.json, including drawings.* and the workspace opt-out', () => {
  assert.equal(policyFor('watchlist'), 'cas');
  assert.equal(policyFor('paper'), 'cas');
  assert.equal(policyFor('scripts'), 'merge');
  assert.equal(policyFor('alerts'), 'merge');
  assert.equal(policyFor('theme'), 'lww');
  assert.equal(policyFor('tdKey'), 'local');
  assert.equal(policyFor('drawings.AAPL'), 'cas');
  assert.equal(policyFor('drawings.^GSPC'), 'cas');
  assert.equal(policyFor('drawings.EUR/USD'), 'cas');
  assert.equal(policyFor('drawings.'), null, 'a prefix alone is not a key');
  assert.equal(policyFor('workspace'), 'cas');
  assert.equal(policyFor('workspace', { syncWorkspace: false }), 'local');
  assert.equal(policyFor('somethingNew'), null);
  assert.equal(isSynced('tdKey'), false);
  assert.equal(isSynced('watchlist'), true);
});

test('keys with whitespace, control characters or excessive length are invalid', () => {
  for (const k of ['', 'a b', 'a\nb', 'a\u0000', 'a‎b', 'x'.repeat(201)]) assert.equal(isValidKey(k), false, JSON.stringify(k));
  for (const k of ['watchlist', 'drawings.BINANCE:BTCUSDT', 'drawings.EURUSD=X', 'drawings.日経']) assert.equal(isValidKey(k), true, k);
});

// --- merge -------------------------------------------------------------------------------------

const s = (id, extra = {}) => ({ id, name: id, ...extra });

test('parseIdArray accepts arrays of unique string ids only', () => {
  assert.deepEqual(parseIdArray(null), []);
  assert.deepEqual(parseIdArray('[{"id":"a"}]'), [{ id: 'a' }]);
  for (const bad of ['{', '{}', '[1]', '[{"id":1}]', '[{"id":""}]', '[{"id":"a"},{"id":"a"}]', '[null]', '[[]]']) {
    assert.equal(parseIdArray(bad), null, bad);
  }
});

test('three-way merge keeps additions, deletions and edits from both sides', () => {
  const base = [s('a'), s('b'), s('c')];
  const ours = [s('a', { name: 'A2' }), s('b'), s('d')]; // server: edit a, delete c, add d
  const theirs = [s('a'), s('c'), s('e')]; // client: delete b, add e
  assert.deepEqual(mergeIdArrays(base, ours, theirs), [s('a', { name: 'A2' }), s('d'), s('e')]);
});

test('three-way merge: concurrent edits use the newer `updated`, ties go to the client', () => {
  const base = [s('a', { updated: 1 })];
  assert.deepEqual(mergeIdArrays(base, [s('a', { name: 'srv', updated: 5 })], [s('a', { name: 'cli', updated: 3 })]), [s('a', { name: 'srv', updated: 5 })]);
  assert.deepEqual(mergeIdArrays(base, [s('a', { name: 'srv', updated: 3 })], [s('a', { name: 'cli', updated: 5 })]), [s('a', { name: 'cli', updated: 5 })]);
  assert.deepEqual(mergeIdArrays(base, [s('a', { name: 'srv', updated: 3 })], [s('a', { name: 'cli', updated: 3 })]), [s('a', { name: 'cli', updated: 3 })]);
  // alerts carry no `updated`: the client's edit wins
  assert.deepEqual(mergeIdArrays([s('x')], [s('x', { active: false })], [s('x', { price: 2 })]), [s('x', { price: 2 })]);
});

test('three-way merge: an edit beats a concurrent deletion', () => {
  const base = [s('a'), s('b')];
  assert.deepEqual(mergeIdArrays(base, [s('b')], [s('a', { name: 'kept' }), s('b')]), [s('b'), s('a', { name: 'kept' })]);
  assert.deepEqual(mergeIdArrays(base, [s('a', { name: 'kept' }), s('b')], [s('b')]), [s('a', { name: 'kept' }), s('b')]);
});

test('merge without a base infers no deletions', () => {
  assert.deepEqual(mergeIdArrays(null, [s('a'), s('b')], [s('b'), s('c')]), [s('a'), s('b'), s('c')]);
});

// --- state store -------------------------------------------------------------------------------

test('a fresh database has an epoch, rev 0 and an empty snapshot', () => withState({}, (st) => {
  const snap = st.snapshot();
  assert.match(snap.epoch, /^[0-9a-f]{16}$/);
  assert.equal(snap.rev, 0);
  assert.deepEqual(snap.keys, {});
}));

test('CAS: writes apply on their base version; stale writes get 409 with the current value', () => withState({}, (st) => {
  const epoch = st.epoch();
  const r1 = st.write('paper', { value: '{"cash":100}', baseVersion: 0, epoch, clientId: 'A' });
  assert.deepEqual([r1.version, r1.rev, r1.changed], [1, 1, true]);
  const r2 = st.write('paper', { value: '{"cash":90}', baseVersion: 1, epoch, clientId: 'A' });
  assert.equal(r2.version, 2);
  // a beforeunload write from a tab that never saw version 2
  assert.throws(() => st.write('paper', { value: '{"cash":100,"stale":true}', baseVersion: 1, epoch, clientId: 'B' }),
    (e) => e instanceof SyncError && e.status === 409 && e.body.error === 'conflict' && e.body.version === 2 && e.body.value === '{"cash":90}');
  assert.equal(st.snapshot().keys.paper.v, '{"cash":90}');
}));

test('byte-identical writes never bump the version, even from a stale base', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('workspace', { value: 'W', baseVersion: 0, epoch });
  st.write('workspace', { value: 'W2', baseVersion: 1, epoch });
  const r = st.write('workspace', { value: 'W2', baseVersion: 1, epoch });
  assert.deepEqual([r.version, r.changed], [2, false]);
  assert.equal(st.rev(), 2);
}));

test('deletions are tombstones that replicate, and a key can be re-created on top of one', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('theme', { value: 'dark', baseVersion: 0, epoch });
  const d = st.write('theme', { value: null, baseVersion: 1, epoch });
  assert.deepEqual([d.version, d.deleted], [2, true]);
  assert.deepEqual(st.snapshot().keys.theme, { v: null, ver: 2, deleted: true });
  assert.deepEqual(st.changesSince(1).map((c) => [c.key, c.deleted]), [['theme', true]]);
  assert.equal(st.write('theme', { value: null, baseVersion: 2, epoch }).changed, false, 'deleting twice is a no-op');
  const back = st.write('theme', { value: 'light', baseVersion: 2, epoch });
  assert.deepEqual([back.version, back.deleted], [3, false]);
}));

test('LWW keys accept writes from any base', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('lang', { value: 'en', baseVersion: 0, epoch });
  st.write('lang', { value: 'de', baseVersion: 1, epoch });
  assert.equal(st.write('lang', { value: 'fr', baseVersion: 0, epoch }).version, 3);
}));

test('merge keys: a stale write is merged against its base and the result is returned', () => withState({}, (st) => {
  const epoch = st.epoch();
  const v1 = JSON.stringify([s('a', { updated: 1 })]);
  st.write('scripts', { value: v1, baseVersion: 0, epoch, clientId: 'A' });
  // device A adds b (version 2); device B, still on version 1, adds c
  st.write('scripts', { value: JSON.stringify([s('a', { updated: 1 }), s('b', { updated: 2 })]), baseVersion: 1, epoch, clientId: 'A' });
  const sent = JSON.stringify([s('a', { updated: 1 }), s('c', { updated: 3 })]);
  const r = st.write('scripts', { value: sent, baseVersion: 1, epoch, clientId: 'B' });
  assert.equal(r.version, 3);
  assert.deepEqual(JSON.parse(r.value).map((e) => e.id), ['a', 'b', 'c']);
  assert.equal(st.snapshot().keys.scripts.v, r.value);
}));

test('merge keys: a stale delete of an entry removes it; a whole-key delete needs the current version', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('alerts', { value: JSON.stringify([s('a'), s('b')]), baseVersion: 0, epoch });
  st.write('alerts', { value: JSON.stringify([s('a'), s('b'), s('c')]), baseVersion: 1, epoch });
  const r = st.write('alerts', { value: JSON.stringify([s('b')]), baseVersion: 1, epoch }); // deleted a, from version 1
  assert.deepEqual(JSON.parse(r.value).map((e) => e.id), ['b', 'c']);
  refused(() => st.write('alerts', { value: null, baseVersion: 1, epoch }), 409, 'conflict');
}));

test('merge keys fall back to last write wins when a value is not an id-array', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('scripts', { value: '[{"id":"a"}]', baseVersion: 0, epoch });
  st.write('scripts', { value: '[{"id":"a"},{"id":"b"}]', baseVersion: 1, epoch });
  const r = st.write('scripts', { value: 'not json', baseVersion: 1, epoch });
  assert.equal(r.version, 3);
  assert.equal(st.snapshot().keys.scripts.v, 'not json');
}));

test(`merge history keeps the last ${HISTORY_DEPTH} versions; older bases merge without deletions`, () => withState({}, (st, db) => {
  const epoch = st.epoch();
  let list = [];
  for (let i = 1; i <= HISTORY_DEPTH + 5; i++) {
    list = [...list, s(`e${i}`)];
    st.write('scripts', { value: JSON.stringify(list), baseVersion: i - 1, epoch });
  }
  const versions = db.prepare("SELECT version FROM kv_history WHERE key = 'scripts' ORDER BY version").all().map((r) => r.version);
  assert.equal(versions.length, HISTORY_DEPTH);
  assert.equal(versions[0], 6);
  // a client on pruned version 2 that deleted e1: without the base, e1 is kept
  const r = st.write('scripts', { value: JSON.stringify([s('e2'), s('new')]), baseVersion: 2, epoch });
  const ids = JSON.parse(r.value).map((e) => e.id);
  assert.ok(ids.includes('e1') && ids.includes('new') && ids.length === HISTORY_DEPTH + 6);
}));

test('local and unknown keys are refused; a stale epoch is refused', () => withState({ syncWorkspace: false }, (st) => {
  const epoch = st.epoch();
  refused(() => st.write('tdKey', { value: 'secret', baseVersion: 0, epoch }), 422, 'This key is not synced');
  refused(() => st.write('workspace', { value: 'x', baseVersion: 0, epoch }), 422, 'This key is not synced');
  refused(() => st.write('nope', { value: 'x', baseVersion: 0, epoch }), 422, 'This key is not synced');
  refused(() => st.write('watchlist', { value: 'x', baseVersion: 0, epoch: 'old' }), 409, 'epoch');
  assert.equal(st.rev(), 0);
}));

test('a workspace stored while syncing stays out of snapshots and feeds once SYNC_WORKSPACE=false', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-sync-'));
  try {
    let { db } = openDatabase(dir);
    const on = createSyncState(db);
    on.write('workspace', { value: 'W', baseVersion: 0, epoch: on.epoch() });
    db.close();
    ({ db } = openDatabase(dir));
    const off = createSyncState(db, { syncWorkspace: false });
    assert.deepEqual(off.snapshot().keys, {});
    assert.deepEqual(off.changesSince(0), []);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revs strictly increase across keys; changesSince returns the latest state per key in rev order', () => withState({}, (st) => {
  const epoch = st.epoch();
  st.write('theme', { value: 'a', baseVersion: 0, epoch });
  st.write('lang', { value: 'en', baseVersion: 0, epoch });
  st.write('theme', { value: 'b', baseVersion: 1, epoch, clientId: 'X' });
  assert.deepEqual(st.changesSince(0).map((c) => [c.key, c.rev, c.v, c.by]), [['lang', 2, 'en', null], ['theme', 3, 'b', 'X']]);
  assert.deepEqual(st.changesSince(2).map((c) => c.key), ['theme']);
}));

test('listeners hear committed changes only; resetEpoch starts a new epoch', () => withState({}, (st) => {
  const heard = [];
  st.onChange((c) => heard.push(c));
  const epoch = st.epoch();
  st.write('theme', { value: 'a', baseVersion: 0, epoch, clientId: 'A' });
  st.write('theme', { value: 'a', baseVersion: 1, epoch }); // no-op
  try { st.write('paper', { value: 'x', baseVersion: 5, epoch }); } catch { /* conflict */ }
  assert.deepEqual(heard, [{ key: 'theme', v: 'a', ver: 1, deleted: false, rev: 1, by: 'A' }]);
  const next = st.resetEpoch();
  assert.notEqual(next, epoch);
  assert.equal(st.epoch(), next);
}));
