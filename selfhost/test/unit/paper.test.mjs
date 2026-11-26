// Server-side paper trading (selfhost/docs/PHASE5-PAPER.md): the evaluator owns the live account only
// while no main window is present, runs upstream's real PaperAccount, and commits each result with
// its notifications as a compare-and-swap; anything else changing the account starts a new generation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../storage/db.mjs';
import { createSyncState } from '../../sync/state.mjs';
import { createOutbox } from '../../notify/outbox.mjs';
import { PaperAccount } from '../../../public/js/paper.js';
import { createPresence, PRESENCE_LEASE_MS } from '../../paper/presence.mjs';
import { createPaperEvaluator, paperPayload, BY } from '../../paper/evaluator.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A browser-built account: AAPL at 190, then the given orders placed. */
function browserAccount(orders = [], { balance = 100_000, positions = {} } = {}) {
  const a = new PaperAccount({ balance });
  a.tick('YAHOO:AAPL', 190, 1);
  for (const o of orders) assert.equal(a.placeOrder(o, { price: a.last[o.symbol] ?? 190, time: 1 }).ok, true, JSON.stringify(o));
  Object.assign(a.positions, positions);
  return a;
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wl-paper-'));
  dirs.push(dir);
  const { db } = openDatabase(dir);
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const sync = createSyncState(db, { now });
  const outbox = createOutbox(db, { providers: [{ id: 'fake', isConfigured: () => true, send: async () => ({ ok: true }) }], now });
  const presence = createPresence({ now });
  const paper = createPaperEvaluator({ sync, db, outbox, presence, publicUrl: 'https://w.example', now });
  const browserSave = (acct) => {
    const cur = sync.get('paper');
    return sync.write('paper', { value: JSON.stringify(acct.toJSON()), baseVersion: cur.version, epoch: sync.epoch(), clientId: 'browser' });
  };
  const stored = () => new PaperAccount({}, JSON.parse(sync.get('paper').value));
  const rows = () => db.prepare('SELECT dedup_key, payload FROM notification_outbox ORDER BY id').all();
  const away = () => { clock.t += PRESENCE_LEASE_MS + 1; paper.tick(); clock.t += 1; }; // prices come after the takeover
  return { db, sync, clock, presence, paper, browserSave, stored, rows, away };
}

const limitBuy = { symbol: 'YAHOO:AAPL', side: 'buy', type: 'limit', qty: 10, price: 185 };

test('the server fills only after the browser has been away for the lease', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy]));
  s.paper.tick();
  assert.equal(s.paper.status().owner, 'browser', 'a browser may be open right after a start');
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().orders.length, 1, 'no fill while the browser owns the account');
  s.away();
  assert.equal(s.paper.status().owner, 'server');
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 186, at: s.clock.t });
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  const acct = s.stored();
  assert.equal(acct.orders.length, 0);
  assert.equal(acct.positions['YAHOO:AAPL'].qty, 10);
  assert.equal(acct.positions['YAHOO:AAPL'].avg, 185, 'a limit fills at its own price');
  assert.equal(s.sync.changesSince(0).at(-1).by, BY);
  const [row] = s.rows();
  assert.match(row.dedup_key, new RegExp(`^paper:${s.sync.epoch()}:\\d+:0$`));
  assert.deepEqual(JSON.parse(row.payload), { title: 'AAPL limit filled at 185', message: 'Buy 10 · Paper', url: 'https://w.example/#s=YAHOO%3AAAPL' });
});

test('a stop loss fills while away; the browser coming back takes over first and gets current marks', () => {
  const s = setup();
  const acct = browserAccount([{ symbol: 'YAHOO:AAPL', side: 'buy', type: 'market', qty: 5 }]);
  acct.setBracket('YAHOO:AAPL', { sl: 180 });
  s.browserSave(acct);
  s.away();
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 185, at: s.clock.t }); // no fill: marks moved
  s.presence.touch();
  s.paper.handover(); // a main window's page is being served
  assert.equal(s.stored().last['YAHOO:AAPL'], 185, 'the browser starts from the server\'s latest marks');
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 170, at: s.clock.t });
  assert.equal(s.stored().positions['YAHOO:AAPL'].qty, 5, 'the browser owns it now: the server does nothing');
  s.away();
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 179, at: s.clock.t });
  const after = s.stored();
  assert.equal(after.positions['YAHOO:AAPL'], undefined, 'stopped out');
  assert.equal(JSON.parse(s.rows().at(-1).payload).title, 'AAPL stop loss filled at 179');
});

test('a price received before the account changed cannot fill an order placed after it', () => {
  const s = setup();
  s.browserSave(browserAccount());
  s.away();
  const earlier = s.clock.t;
  s.clock.t += 1_000;
  const withOrder = s.stored();
  assert.equal(withOrder.placeOrder(limitBuy, { price: 190, time: 2 }).ok, true);
  s.browserSave(withOrder); // a browser (or the API) slipped in a new order: an external change
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 180, at: earlier }); // an older price, delivered late
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 181, at: s.clock.t }); // the same millisecond as the change
  assert.equal(s.stored().orders.length, 1, 'dropped: received before (or as) the change');
  s.clock.t += 1;
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().orders.length, 0, 'a price after the change fills');
});

test('a stale price is not a current price', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy]));
  s.away();
  s.clock.t += 20_000; // received after the takeover, but evaluated 11 s later (a backed-up queue)
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t - 11_000 });
  assert.equal(s.stored().orders.length, 1);
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t - 9_000 });
  assert.equal(s.stored().orders.length, 0, 'within 10 s it fills');
});

test('the server\'s own commits do not invalidate the prices that follow', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy, { symbol: 'YAHOO:AAPL', side: 'buy', type: 'limit', qty: 1, price: 175 }]));
  s.away();
  s.clock.t += 5_000;
  // Both prices were received before the first commit (queued); the commit must not drop the second.
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t - 2_000 });
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 174, at: s.clock.t - 1_000 });
  assert.equal(s.stored().orders.length, 0, 'both filled from the same stream');
  assert.equal(s.rows().length, 2);
});

test('a rejection is committed and pushed, with a key per result', () => {
  const s = setup();
  s.browserSave(browserAccount([{ symbol: 'YAHOO:AAPL', side: 'buy', type: 'limit', qty: 600, price: 185 }], { balance: 200_000 }));
  // Spend the buying power behind the order's back (another position), so the fill is rejected.
  const acct = s.stored();
  acct.cash = 1_000;
  s.browserSave(acct);
  s.away();
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().orders.length, 0, 'the rejected order is removed');
  const [row] = s.rows();
  assert.match(row.dedup_key, /:0$/);
  assert.deepEqual(JSON.parse(row.payload).title, 'AAPL limit order rejected');
});

test('a transient storage failure replays that price once', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy]));
  let fail = 1;
  const real = s.sync.mutate;
  s.sync.mutate = (key, fn, opts) => real(key, (cur, meta) => { const v = fn(cur, meta); if (fail-- > 0) throw new Error('disk I/O error'); return v; }, opts); // fails at the write, after the callback
  const paper = createPaperEvaluator({ sync: s.sync, db: s.db, outbox: null, presence: s.presence, now: () => s.clock.t });
  s.clock.t += PRESENCE_LEASE_MS + 1; paper.tick(); s.clock.t += 1;
  paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().orders.length, 0, 'filled on the replay');
  assert.equal(paper.status().paused, null);
  paper.close();
});

test('an import or reset reloads; a deleted account does not crash; watched symbols follow the account', () => {
  const s = setup();
  const seen = [];
  s.paper.onSymbols((syms) => seen.push(syms));
  s.browserSave(browserAccount([limitBuy, { symbol: 'BINANCE:BTCUSDT', side: 'buy', type: 'limit', qty: 1, price: 50_000 }]));
  assert.deepEqual(seen.at(-1).sort(), ['BINANCE:BTCUSDT', 'YAHOO:AAPL']);
  s.away();
  s.sync.replaceAll({ paper: JSON.stringify(browserAccount().toJSON()) }); // an import: a new epoch, no orders
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().positions['YAHOO:AAPL'], undefined, 'nothing from before the import filled');
  assert.deepEqual(s.paper.symbols(), []);
  s.sync.write('paper', { value: null, baseVersion: s.sync.get('paper').version, epoch: s.sync.epoch() });
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 180, at: s.clock.t });
  assert.equal(s.sync.get('paper').value, null, 'a deleted account stays deleted (nothing to fill)');
});

test('the push text for fills and rejections', () => {
  assert.deepEqual(paperPayload({ symbol: 'BINANCE:BTCUSDT', side: 'sell', qty: 0.5, price: 61000.25, reason: 'Take profit' }, null),
    { title: 'BTCUSDT take profit filled at 61000.25', message: 'Sell 0.5 · Paper' });
  assert.equal(paperPayload({ rejected: true, symbol: 'YAHOO:AAPL', order: { type: 'stop' }, reason: 'Not enough buying power' }, null).message, 'Not enough buying power · Paper');
});

test('a commit against an account that changed underneath writes nothing and reloads', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy]));
  // An evaluator that does not hear about changes (as if one slipped in between its load and commit).
  const deaf = { ...s.sync, onChange: () => () => {}, onEpoch: () => () => {}, get: s.sync.get, mutate: s.sync.mutate, epoch: s.sync.epoch };
  const paper = createPaperEvaluator({ sync: deaf, db: s.db, outbox: null, presence: s.presence, now: () => s.clock.t });
  s.clock.t += PRESENCE_LEASE_MS + 1; paper.tick(); s.clock.t += 1;
  const cancelled = s.stored();
  cancelled.cancelOrder(cancelled.orders[0].id);
  s.browserSave(cancelled); // the browser cancelled the order
  const before = s.sync.get('paper').version;
  paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.sync.get('paper').version, before, 'the stale account was not written');
  assert.equal(s.stored().positions['YAHOO:AAPL'], undefined, 'the cancelled order did not fill');
  paper.price({ symbol: 'YAHOO:AAPL', price: 183, at: s.clock.t + 1 });
  assert.equal(s.stored().positions['YAHOO:AAPL'], undefined, 'after the reload, there is nothing to fill');
  paper.close();
});

test('a failed save retries from the account as it was, other marks included (a rejection stays a rejection)', () => {
  const s = setup();
  // Long 10 A at 100, a pending buy of 10 B at 90, little cash: when A falls, B must be rejected.
  const a = new PaperAccount({ balance: 1_000, leverage: 2 });
  a.tick('YAHOO:A', 100, 1); a.tick('YAHOO:B', 100, 1);
  assert.equal(a.placeOrder({ symbol: 'YAHOO:A', side: 'buy', type: 'market', qty: 10 }, { price: 100, time: 1 }).ok, true);
  assert.equal(a.placeOrder({ symbol: 'YAHOO:B', side: 'buy', type: 'limit', qty: 10, price: 90 }, { price: 100, time: 1 }).ok, true);
  s.browserSave(a);
  let fail = 1;
  const real = s.sync.mutate;
  s.sync.mutate = (key, fn, opts) => real(key, (cur, meta) => { const v = fn(cur, meta); if (fail-- > 0) throw new Error('disk I/O error'); return v; }, opts); // fails at the write, after the callback
  s.away();
  s.paper.price({ symbol: 'YAHOO:A', price: 50, at: s.clock.t }); // no fill: only a mark (not saved)
  s.paper.price({ symbol: 'YAHOO:B', price: 89, at: s.clock.t }); // rejected; the save fails once
  const acct = s.stored();
  assert.equal(acct.positions['YAHOO:B'], undefined, 'still a rejection on the retry, not a fill');
  assert.equal(JSON.parse(s.rows().at(-1).payload).title, 'B limit order rejected');
});

test('a transient failure keeps the queued prices that follow', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy, { symbol: 'YAHOO:AAPL', side: 'buy', type: 'limit', qty: 1, price: 175 }]));
  let fail = 1;
  const real = s.sync.mutate;
  s.sync.mutate = (key, fn, opts) => real(key, (cur, meta) => { const v = fn(cur, meta); if (fail-- > 0) throw new Error('disk I/O error'); return v; }, opts); // fails at the write, after the callback
  s.away();
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 174, at: s.clock.t });
  assert.equal(s.stored().orders.length, 0, 'both crossings filled despite the failure');
});

test('an outside change lifts a pause from earlier storage failures', () => {
  const s = setup();
  s.browserSave(browserAccount([limitBuy]));
  let failing = true;
  const real = s.sync.mutate;
  s.sync.mutate = (key, fn, opts) => real(key, (cur, meta) => { const v = fn(cur, meta); if (failing) throw new Error('disk full'); return v; }, opts);
  s.away();
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.match(String(s.paper.status().paused), /disk full/);
  failing = false; // storage repaired; then the account is imported or changed
  s.sync.replaceAll({ paper: JSON.stringify(browserAccount([limitBuy]).toJSON()) });
  assert.equal(s.paper.status().paused, null);
  s.clock.t += 1;
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 184, at: s.clock.t });
  assert.equal(s.stored().orders.length, 0, 'fills again');
  // Paused again; this time a browser save (an ordinary change, not an import) lifts it.
  failing = true;
  const again = s.stored();
  assert.equal(again.placeOrder({ symbol: 'YAHOO:AAPL', side: 'buy', type: 'limit', qty: 1, price: 170 }, { price: 184, time: 3 }).ok, true);
  failing = false; s.browserSave(again); failing = true;
  s.clock.t += 1;
  s.paper.price({ symbol: 'YAHOO:AAPL', price: 169, at: s.clock.t });
  assert.match(String(s.paper.status().paused), /disk full/);
  failing = false;
  const edited = s.stored();
  edited.cancelOrder(edited.orders[0].id); // a real change (an identical save makes no new version)
  s.browserSave(edited);
  assert.equal(s.paper.status().paused, null, 'a browser save lifts the pause too');
});
