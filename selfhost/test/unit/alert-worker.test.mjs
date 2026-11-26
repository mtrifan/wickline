// The alert evaluator's sessions, resume and re-arm rules; the Yahoo source against a fake relay;
// the supervisor's restarts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createEvaluator, normalizeSymbol } from '../../alerts/evaluate.mjs';
import { createYahooSource, yahooTicker, sseParser } from '../../alerts/sources/yahoo.mjs';
import { createAlertSupervisor } from '../../alerts/supervisor.mjs';

const cleanup = [];
after(async () => { for (const fn of cleanup.reverse()) await fn(); });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

const alert = (extra = {}) => ({ id: 'a', symbol: 'YAHOO:AAPL', condition: 'up', price: 100, active: true, ...extra });

test('symbols: "AAPL" and "YAHOO:AAPL" are one; other providers are not Yahoo', () => {
  assert.equal(normalizeSymbol('AAPL'), 'YAHOO:AAPL');
  assert.equal(normalizeSymbol('binance:BTCUSDT'), 'BINANCE:BTCUSDT');
  assert.equal(yahooTicker('AAPL'), 'AAPL');
  assert.equal(yahooTicker('YAHOO:^GSPC'), '^GSPC');
  assert.equal(yahooTicker('BINANCE:BTCUSDT'), null);
});

test('each session keeps its own previous price', () => {
  const ev = createEvaluator();
  ev.setAlerts([alert()]);
  ev.tick({ symbol: 'AAPL', price: 99, session: 1 }); // regular close
  assert.deepEqual(ev.tick({ symbol: 'AAPL', price: 101, session: 0 }), [], 'first pre-market tick: no chain yet');
  assert.equal(ev.tick({ symbol: 'AAPL', price: 102, session: 0 }).length, 0);
  assert.equal(ev.tick({ symbol: 'AAPL', price: 100.5, session: 1 }).length, 1, 'regular chain: 99 -> 100.5 crosses');
});

test('with extended hours off, only regular-session ticks count', () => {
  const ev = createEvaluator({ extendedHours: false });
  ev.setAlerts([alert()]);
  ev.tick({ symbol: 'AAPL', price: 99, session: 0 });
  assert.equal(ev.tick({ symbol: 'AAPL', price: 101, session: 2 }).length, 0);
  ev.tick({ symbol: 'AAPL', price: 99, session: 1 });
  assert.equal(ev.tick({ symbol: 'AAPL', price: 101, session: 1 }).length, 1);
});

test('fires once; a re-arm ignores the first price, like upstream', () => {
  const ev = createEvaluator();
  ev.setAlerts([alert()]);
  ev.tick({ symbol: 'AAPL', price: 99 });
  assert.equal(ev.tick({ symbol: 'AAPL', price: 101 }).length, 1);
  assert.equal(ev.tick({ symbol: 'AAPL', price: 99 }).length, 0);
  assert.equal(ev.tick({ symbol: 'AAPL', price: 101 }).length, 0, 'inactive until re-armed');
  ev.setAlerts([alert({ active: false })]); // the server value after the trigger
  ev.setAlerts([alert()]); // re-armed
  assert.equal(ev.tick({ symbol: 'AAPL', price: 99 }).length, 0);
  assert.equal(ev.tick({ symbol: 'AAPL', price: 101 }).length, 1);
  assert.deepEqual(ev.symbols(), [], 'a fired alert is not watched');
});

test('resume: a recent stored price in the same session becomes the previous price (gap)', () => {
  const now = 1_000_000;
  const ev = createEvaluator({ resumeMaxGapMs: 15 * 60_000 });
  ev.setAlerts([alert()], { resume: { a: { price: 99, at: now - 60_000, session: 1 } }, now });
  assert.deepEqual(ev.tick({ symbol: 'AAPL', price: 101, session: 1, at: now }), [{ id: 'a', price: 101, at: now, gap: true }]);
  const old = createEvaluator({ resumeMaxGapMs: 15 * 60_000 });
  old.setAlerts([alert()], { resume: { a: { price: 99, at: now - 16 * 60_000, session: 1 } }, now });
  assert.equal(old.tick({ symbol: 'AAPL', price: 101, session: 1 }).length, 0, 'too old: the first tick is ignored');
  const other = createEvaluator();
  other.setAlerts([alert()], { resume: { a: { price: 99, at: now - 60_000, session: 2 } }, now });
  assert.equal(other.tick({ symbol: 'AAPL', price: 101, session: 1 }).length, 0, 'another session: ignored');
});

test('progress reports the latest price per alert', () => {
  const ev = createEvaluator();
  ev.setAlerts([alert(), alert({ id: 'b', symbol: 'MSFT' })]);
  ev.tick({ symbol: 'AAPL', price: 99, session: 1, at: 5 });
  assert.deepEqual(ev.progress(), { a: { price: 99, at: 5, session: 1 } });
  ev.setAlerts([alert({ id: 'b', symbol: 'MSFT' })]);
  assert.deepEqual(ev.progress(), {}, 'deleted alerts are dropped');
});

test('the SSE parser handles split chunks, comments and CRLF', () => {
  const got = [];
  const push = sseParser((d) => got.push(d));
  push('retry: 3000\n\n: ping\n\nda');
  push('ta: {"s":"A"}\r\n\r\ndata: x\n');
  push('\n');
  assert.deepEqual(got, ['{"s":"A"}', 'x']);
});

/** A fake upstream relay: GET /api/yahoo/stream?symbols=… held open; send(tick) writes to matching streams. */
async function fakeRelay() {
  const streams = new Set();
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ symbols: url.searchParams.get('symbols').split(','), internal: req.headers['x-wickline-internal'] });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 3000\n\n');
    const s = { symbols: new Set(url.searchParams.get('symbols').split(',')), res };
    streams.add(s);
    req.on('close', () => streams.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    streams,
    send: (tick) => { for (const s of streams) if (s.symbols.has(tick.s)) s.res.write(`data: ${JSON.stringify(tick)}\n\n`); },
    dropAll: () => { for (const s of streams) s.res.destroy(); },
  };
}

test('the Yahoo source shards by 100, sends the credential, and reconnects after a drop', async () => {
  const relay = await fakeRelay();
  const ticks = [];
  const src = createYahooSource({ baseUrl: relay.base, headers: { 'x-wickline-internal': 'k' }, onTick: (t) => ticks.push(t) });
  cleanup.push(() => src.close());
  src.setSymbols(Array.from({ length: 150 }, (_, i) => `S${i}`));
  await until(() => relay.streams.size === 2);
  assert.deepEqual(relay.seen.map((x) => x.symbols.length).sort(), [100, 50]);
  assert.ok(relay.seen.every((x) => x.internal === 'k'));
  relay.send({ s: 'S1', p: 10.5, m: 1 });
  await until(() => ticks.length === 1);
  assert.deepEqual({ ...ticks[0], at: 0 }, { symbol: 'YAHOO:S1', price: 10.5, session: 1, at: 0 });
  relay.dropAll();
  await until(() => relay.streams.size === 2 && relay.seen.length === 4);
  relay.send({ s: 'S120', p: 3, m: 0 });
  await until(() => ticks.length === 2);
  assert.equal(ticks[1].session, 0);
  src.setSymbols(['S1']);
  await until(() => relay.streams.size === 1);
});

test('the supervisor restarts a worker that exits, with backoff', async () => {
  const sync = { snapshot: () => ({ keys: {} }), onChange: () => () => {} };
  const ledger = { resumePoints: () => ({}), trigger: () => ({ fired: false }), saveProgress() {} };
  const crashing = new URL('data:text/javascript,process.exit(3)');
  const sup = createAlertSupervisor({ ledger, sync, workerData: {}, workerUrl: crashing });
  cleanup.push(() => sup.stop());
  sup.start();
  await until(() => sup.status().restarts >= 2, 5000);
  assert.match(sup.status().lastError, /code 3/);
  assert.equal(sup.status().running, false);
});
