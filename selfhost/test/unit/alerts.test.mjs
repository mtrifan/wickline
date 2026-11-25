// The alerts merge and trigger identity (PLAN §2.5.6): server-owned trigger fields, re-arm rules,
// 30-day tombstones, the dual window, and exactly one queued push per trigger.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../storage/db.mjs';
import { createSyncState, SyncError, HISTORY_DEPTH } from '../../sync/state.mjs';
import { createOutbox } from '../../notify/outbox.mjs';
import { mergeAlerts, DUAL_WINDOW_MS } from '../../alerts/merge.mjs';
import { createAlertLedger, alertPayload, TOMBSTONE_MS } from '../../alerts/ledger.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const armed = (id, extra = {}) => ({ id, symbol: 'NASDAQ:AAPL', condition: 'up', price: 190, message: '', active: true, created: 1, ...extra });
const fired = (id, at, price = 191, extra = {}) => ({ ...armed(id, extra), active: false, triggeredAt: at, triggerPrice: price });
const ids = (arr) => arr.map((a) => a.id);

// ---- the pure merge ------------------------------------------------------------------------

test('a browser trigger on an alert the server still has armed is accepted', () => {
  const r = mergeAlerts({ base: [armed('a')], ours: [armed('a')], theirs: [fired('a', 1000)] });
  assert.deepEqual(r.merged, [fired('a', 1000)]);
  assert.deepEqual(ids(r.triggers), ['a']);
});

test('a browser trigger the server already recorded collapses into the server one', () => {
  const r = mergeAlerts({ base: [armed('a')], ours: [fired('a', 1000, 191)], theirs: [fired('a', 1030, 192)] });
  assert.deepEqual(r.merged, [fired('a', 1000, 191)]);
  assert.deepEqual(r.triggers, []);
});

test('a re-arm and a new trigger while the server was away is a new trigger', () => {
  const r = mergeAlerts({ base: [fired('a', 1000)], ours: [fired('a', 1000)], theirs: [fired('a', 900_000, 195)] });
  assert.deepEqual(r.merged, [fired('a', 900_000, 195)]);
  assert.deepEqual(ids(r.triggers), ['a']);
});

test('a re-arm counts only if the client had seen the trigger it clears', () => {
  const ok = mergeAlerts({ base: [fired('a', 1000)], ours: [fired('a', 1000)], theirs: [armed('a', { triggeredAt: null, triggerPrice: null })] });
  assert.equal(ok.merged[0].active, true);
  assert.equal(ok.merged[0].triggeredAt, null);
  // The server re-armed and fired again since the client's base: the stale re-arm is ignored.
  const stale = mergeAlerts({ base: [fired('a', 1000)], ours: [fired('a', 5000)], theirs: [armed('a', { triggeredAt: null, triggerPrice: null })] });
  assert.deepEqual(stale.merged, [fired('a', 5000)]);
  assert.deepEqual(stale.triggers, []);
});

test('a stale browser still showing an alert armed cannot cancel a server trigger', () => {
  const r = mergeAlerts({ base: [armed('a')], ours: [fired('a', 1000)], theirs: [armed('a', { message: 'note' })] });
  assert.deepEqual(r.merged, [fired('a', 1000, 191, { message: 'note' })], 'other fields still merge');
});

test('other changes to the trigger fields are ignored', () => {
  const r = mergeAlerts({ base: [fired('a', 1000, 191)], ours: [fired('a', 1000, 191)], theirs: [fired('a', 1000, 999)] });
  assert.deepEqual(r.merged, [fired('a', 1000, 191)]);
  const r2 = mergeAlerts({ base: [armed('a')], ours: [armed('a')], theirs: [{ ...armed('a'), active: false }] });
  assert.equal(r2.merged[0].active, true, 'disarming without a trigger time is not a trigger');
});

test('the dual window collapses a stale trigger of a crossing already recorded and since re-armed', () => {
  const lastTriggerAt = () => 1000;
  // The server fired at 1000, another device re-armed; a stale browser reports the same crossing.
  const same = mergeAlerts({ base: [armed('a')], ours: [armed('a')], theirs: [fired('a', 1000 + DUAL_WINDOW_MS)], lastTriggerAt });
  assert.deepEqual(same.merged, [armed('a')]);
  assert.deepEqual(same.triggers, []);
  const later = mergeAlerts({ base: [armed('a')], ours: [armed('a')], theirs: [fired('a', 1001 + DUAL_WINDOW_MS)], lastTriggerAt });
  assert.deepEqual(ids(later.triggers), ['a'], 'outside the window it is a new crossing');
  // The client had seen that trigger and re-armed itself: its new trigger is real even inside the window.
  const own = mergeAlerts({ base: [fired('a', 1000)], ours: [fired('a', 1000)], theirs: [fired('a', 1500)], lastTriggerAt });
  assert.deepEqual(ids(own.triggers), ['a']);
});

test('deletions: tombstoned ids stay deleted; ids added elsewhere stay', () => {
  // The client deleted b; c was added on another device; d was deleted elsewhere and edited here.
  const r = mergeAlerts({
    base: [armed('a'), armed('b'), armed('d')],
    ours: [armed('c'), armed('a'), armed('b')],
    theirs: [armed('a'), armed('d', { message: 'edited' })],
  });
  assert.deepEqual(ids(r.merged), ['c', 'a']);
  assert.deepEqual(r.removed.sort(), ['b']);
  const t = mergeAlerts({ base: [], ours: [armed('a')], theirs: [armed('x'), armed('a')], isTombstoned: (id) => id === 'x' });
  assert.deepEqual(ids(t.merged), ['a'], 'a tombstoned id is not brought back');
});

test('new alerts keep their place at the front; triggers on new entries are never pushed', () => {
  const r = mergeAlerts({ base: [armed('a')], ours: [armed('a'), armed('b')], theirs: [fired('n', 1000), armed('a')] });
  assert.deepEqual(ids(r.merged), ['n', 'a', 'b']);
  assert.deepEqual(r.triggers, [], 'a trigger the server never saw armed (an upload) is not pushed');
});

test('the notification mirrors upstream\'s toast and links to the chart', () => {
  const p = alertPayload(fired('a', 1000, 191.25, { symbol: 'BINANCE:BTCUSDT', condition: 'cross', price: 100000, message: 'take profit' }), 'https://w.example');
  assert.deepEqual(p, { title: 'BTCUSDT crossing 100000', message: 'Now 191.25 · take profit', url: 'https://w.example/#s=BINANCE%3ABTCUSDT' });
  assert.equal(alertPayload(fired('a', 1, 2), null).url, undefined);
});

// ---- with the database -----------------------------------------------------------------------

function setup({ maxTotalChars, now = () => clock.t } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-alerts-'));
  dirs.push(dir);
  const { db } = openDatabase(dir);
  const sync = createSyncState(db, { now, ...(maxTotalChars ? { maxTotalChars } : {}) });
  const outbox = createOutbox(db, { providers: [{ id: 'fake', isConfigured: () => true, send: async () => ({ ok: true }) }], now });
  const ledger = createAlertLedger(db, { outbox, publicUrl: 'https://w.example', now });
  ledger.attach(sync);
  const changes = [];
  sync.onChange((c) => changes.push(c));
  const rows = () => db.prepare('SELECT dedup_key, payload FROM notification_outbox ORDER BY id').all();
  const write = (value, baseVersion) => sync.write('alerts', { value: JSON.stringify(value), baseVersion, epoch: sync.epoch(), clientId: 'c1' });
  const current = () => JSON.parse(sync.snapshot().keys.alerts.v);
  const version = () => sync.snapshot().keys.alerts.ver;
  return { db, sync, ledger, rows, write, current, version, changes };
}
const clock = { t: 1_000_000 };

test('a browser trigger is recorded and queued exactly once', () => {
  const s = setup();
  s.write([armed('a')], 0);
  s.write([fired('a', 2000)], 1);
  assert.deepEqual(s.rows().map((r) => r.dedup_key), ['alert:a:2000']);
  assert.equal(JSON.parse(s.rows()[0].payload).title, 'AAPL crossing up 190');
  // A second browser reports the same crossing from the old base, then a retry of the first write.
  const r = s.write([fired('a', 2050)], 1);
  assert.deepEqual(JSON.parse(r.value ?? JSON.stringify(s.current())), [fired('a', 2000)]);
  s.write([fired('a', 2000)], 1);
  assert.equal(s.rows().length, 1);
  assert.equal(s.ledger.lastTriggerAt('a'), 2000);
});

test('a server trigger bumps the version, broadcasts, and queues; a late browser trigger collapses', () => {
  const s = setup();
  s.write([armed('a')], 0);
  const r = s.ledger.trigger({ id: 'a', triggerPrice: 190.5, triggeredAt: 3000 });
  assert.deepEqual(r, { fired: true, key: 'a:3000' });
  assert.equal(s.version(), 2);
  assert.deepEqual(s.current(), [fired('a', 3000, 190.5)]);
  assert.equal(s.changes.at(-1).by, 'server');
  assert.deepEqual(s.rows().map((x) => x.dedup_key), ['alert:a:3000']);
  const late = s.write([fired('a', 3010, 190.6)], 1);
  assert.deepEqual(JSON.parse(late.value), [fired('a', 3000, 190.5)]);
  assert.equal(late.changed, false);
  assert.equal(s.rows().length, 1);
  // Already fired: the server does nothing.
  assert.deepEqual(s.ledger.trigger({ id: 'a', triggerPrice: 191, triggeredAt: 4000 }), { fired: false });
  assert.deepEqual(s.ledger.trigger({ id: 'missing', triggerPrice: 191 }), { fired: false });
  assert.equal(s.version(), 2);
});

test('a browser trigger first: the server trigger for the same crossing does nothing', () => {
  const s = setup();
  s.write([armed('a')], 0);
  s.write([fired('a', 2000)], 1);
  assert.deepEqual(s.ledger.trigger({ id: 'a', triggerPrice: 191, triggeredAt: 2001 }), { fired: false });
  assert.equal(s.rows().length, 1);
});

test('a base that aged out of history is a conflict: the browser re-hydrates', () => {
  const s = setup();
  s.write([armed('a')], 0);
  for (let i = 0; i < HISTORY_DEPTH + 1; i++) s.write([armed('a', { message: `m${i}` })], s.version());
  assert.throws(() => s.write([fired('a', 2000)], 1), (e) => e instanceof SyncError && e.status === 409 && e.body.error === 'conflict');
  assert.equal(s.rows().length, 0);
});

test('a deleted alert is tombstoned for 30 days against stale browsers and uploads', () => {
  const s = setup();
  s.write([armed('a'), armed('b')], 0);
  s.write([armed('a')], 1); // b deleted
  assert.equal(s.ledger.isTombstoned('b'), true);
  // A new device uploads its copy (base 0) that still has b.
  s.write([armed('b'), armed('a')], 0);
  assert.deepEqual(ids(s.current()), ['a']);
  clock.t += TOMBSTONE_MS + 1;
  assert.equal(s.ledger.isTombstoned('b'), false);
  s.write([armed('b'), armed('a')], 0);
  assert.deepEqual(ids(s.current()), ['b', 'a'], 'after 30 days it can be added again');
});

test('deleting the whole key tombstones every alert in it; an import clears tombstones', () => {
  const s = setup();
  s.write([armed('a')], 0);
  s.sync.write('alerts', { value: null, baseVersion: 1, epoch: s.sync.epoch() });
  assert.equal(s.ledger.isTombstoned('a'), true);
  s.sync.replaceAll({ alerts: JSON.stringify([armed('a')]) });
  assert.equal(s.ledger.isTombstoned('a'), false);
});

test('a refused write records no trigger and queues nothing', () => {
  const s = setup({ maxTotalChars: 400 });
  s.write([armed('a')], 0);
  assert.throws(() => s.write([fired('a', 2000, 191, { message: 'x'.repeat(400) })], 1), (e) => e.status === 413);
  assert.equal(s.rows().length, 0);
  assert.equal(s.ledger.lastTriggerAt('a'), null);
});

test('a value that is not an alerts array falls back to last write wins', () => {
  const s = setup();
  s.write([armed('a')], 0);
  const r = s.sync.write('alerts', { value: '{"not":"an array"}', baseVersion: 1, epoch: s.sync.epoch() });
  assert.equal(r.changed, true);
  assert.equal(s.rows().length, 0);
});
