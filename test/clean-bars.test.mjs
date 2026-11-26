// Tests for lib/clean-bars.mjs: bad prints are clipped, real moves are kept.
import assert from 'node:assert/strict';
import { cleanSpikes, fixFxDailyCloses, isStaleHistory, spliceFreshTail } from '../lib/clean-bars.mjs';

const bar = (i, o, h, l, c) => ({ time: i * 300, open: o, high: h, low: l, close: c, volume: 100 });
// A quiet stretch around 100: bodies 99.9-100.2, wicks +-0.2.
const quiet = (n, base = 100) => Array.from({ length: n }, (_, i) => bar(i, base, base + 0.3, base - 0.2, base + 0.1));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

test('clips a wick far below the neighbours (bad print)', () => {
  const bars = quiet(30);
  bars[15] = bar(15, 100, 100.3, 19.5, 100.1); // like AMD trading at 610 printing 119
  const out = cleanSpikes(bars);
  assert.ok(out[15].low > 99, `low ${out[15].low}`);
  assert.equal(out[15].open, 100);
  assert.equal(out[15].close, 100.1);
});

test('clips a wick far above the neighbours', () => {
  const bars = quiet(30);
  bars[10] = bar(10, 100, 133, 99.8, 100.1);
  const out = cleanSpikes(bars);
  assert.ok(out[10].high < 101, `high ${out[10].high}`);
});

test('fixes an isolated open/close print far away', () => {
  const bars = quiet(30);
  bars[12] = bar(12, 100, 100.3, 40, 40.5);
  const out = cleanSpikes(bars);
  assert.ok(out[12].close > 99 && out[12].low > 99, JSON.stringify(out[12]));
});

test('clips two bad bars next to each other', () => {
  const bars = quiet(30);
  bars[14] = bar(14, 100, 100.3, 99.8, 66); // a bad close...
  bars[15] = bar(15, 66, 100.3, 66, 100.1); // ...and the next bar opening from it
  const out = cleanSpikes(bars);
  for (const i of [14, 15]) assert.ok(out[i].low > 99 && out[i].open > 99 && out[i].close > 99, JSON.stringify(out[i]));
});

test('clips a bad print during a volatile stretch', () => {
  // 1-hour bars on a wild day (+-3% per bar), with one print 40% below.
  const bars = Array.from({ length: 30 }, (_, i) => {
    const c = 100 + i * 1.5;
    return bar(i, c - 1.5, c + 1.5, c - 3, c);
  });
  bars[15] = { ...bars[15], low: 70 };
  const out = cleanSpikes(bars);
  assert.ok(out[15].low > 110, `low ${out[15].low}`);
});

test('keeps a real jump (the following bars move too)', () => {
  const bars = quiet(30).map((b, i) => (i >= 15 ? { ...b, open: b.open + 10, high: b.high + 10, low: b.low + 10, close: b.close + 10 } : b));
  bars[15] = bar(15, 100.1, 111, 100, 110); // the jump bar itself
  const out = cleanSpikes(bars);
  assert.deepEqual(out.slice(14, 18), bars.slice(14, 18));
});

test('keeps normal volatility untouched', () => {
  const bars = Array.from({ length: 60 }, (_, i) => {
    const c = 100 + Math.sin(i / 3) * 2;
    return bar(i, c - 0.3, c + 0.6, c - 0.7, c);
  });
  assert.deepEqual(cleanSpikes(bars), bars);
});

test('leaves the newest bars alone (nothing after them yet)', () => {
  const bars = quiet(30);
  bars[29] = bar(29, 100, 140, 99.8, 139); // breaking news on the live bar
  assert.deepEqual(cleanSpikes(bars)[29], bars[29]);
});

test('does not modify its input', () => {
  const bars = quiet(30);
  bars[15] = bar(15, 100, 100.3, 19.5, 100.1);
  const copy = JSON.parse(JSON.stringify(bars));
  cleanSpikes(bars);
  assert.deepEqual(bars, copy);
});

// Yahoo's daily EURUSD, Nov 2026: each finished day's close is a copy of its open; the next day's
// open is the real close (checked against the same days built from hourly bars).
test('daily forex: a finished day\'s close is rebuilt from the next day\'s open', () => {
  const d = (i, o, h, l, c) => ({ time: i * 86400, open: o, high: h, low: l, close: c, volume: 0 });
  const bars = [d(0, 1.11485, 1.12057, 1.11474, 1.11473), d(1, 1.12225, 1.12506, 1.11469, 1.12225),
    d(2, 1.11684, 1.11707, 1.10836, 1.11689), d(3, 1.10963, 1.11037, 1.10541, 1.10952), d(4, 1.09039, 1.0983, 1.08992, 1.09673)];
  fixFxDailyCloses(bars);
  assert.deepEqual(bars.map((b) => b.close), [1.12225, 1.11684, 1.10963, 1.09039, 1.09673], 'the live day keeps its close');
  assert.equal(bars[0].high, 1.12225, 'the high stretches to the rebuilt close');
  assert.ok(bars.every((b) => b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close)));
});

test('daily forex: bars that already look right are left alone', () => {
  const d = (i, o, c) => ({ time: i * 86400, open: o, high: Math.max(o, c) + 0.002, low: Math.min(o, c) - 0.002, close: c, volume: 0 });
  const bars = [d(0, 1.10, 1.105), d(1, 1.105, 1.098), d(2, 1.098, 1.101), d(3, 1.101, 1.11), d(4, 1.11, 1.112)];
  const before = JSON.stringify(bars);
  fixFxDailyCloses(bars);
  assert.equal(JSON.stringify(bars), before);
});

// Issue #7: Yahoo served MSFT's daily history ending in 2025 while it traded in Nov 2026.
test('a history whose last bar is weeks behind the latest trade is stale; weekends and holidays are not', () => {
  const D = 86400, fri = Date.UTC(2026, 10, 20) / 1000;
  assert.equal(isStaleHistory(Date.UTC(2025, 8, 15) / 1000, fri + 3 * D, D), true, 'a year behind');
  assert.equal(isStaleHistory(fri, fri + 3 * D + 15 * 3600, D), false, "Friday's bar on Monday afternoon");
  assert.equal(isStaleHistory(fri - 4 * D, fri, D), false, 'a holiday week');
  assert.equal(isStaleHistory(Date.UTC(2026, 9, 1) / 1000, Date.UTC(2026, 9, 30) / 1000, 30 * D), false, 'a monthly bar is a month long');
  assert.equal(isStaleHistory(fri, undefined, D), false, 'no market time: not stale');
});

test('the fresh tail replaces the old one from its first bar on', () => {
  const b = (t, c) => ({ time: t, open: c, high: c, low: c, close: c, volume: 1 });
  const old = [b(1, 10), b(2, 11), b(3, 12)];
  assert.deepEqual(spliceFreshTail(old, [b(3, 20), b(4, 21), b(9, 22)]).map((x) => [x.time, x.close]), [[1, 10], [2, 11], [3, 20], [4, 21], [9, 22]]);
  assert.equal(spliceFreshTail(old, []), old);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
