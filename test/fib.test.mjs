// Fibonacci retracement options: the saved shape and its defaults (fib.js), the price of a level
// (linear and log), reading a typed level, the panel's edits, and how a Fib is drawn from its options.
// Run: node test/fib.test.mjs
import assert from 'node:assert/strict';
import {
  FIB_DEFAULT_LEVELS, FIB_LIMITS, activeLevels, addLevel, fibOf, formatLevel, labelText, levelPrice, parseLevel,
  removeLevel, setLevel, setOption,
} from '../public/js/fib.js';
import { DrawingLayer } from '../public/js/drawings.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

ok('a Fib without options has the look it always had', () => {
  const cfg = fibOf({ type: 'fib' });
  assert.deepEqual(cfg.levels.map((l) => l.value), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  assert.deepEqual(cfg.levels.map((l) => l.color), FIB_DEFAULT_LEVELS.map((l) => l.color));
  assert.ok(cfg.levels.every((l) => l.on));
  assert.deepEqual([cfg.trend, cfg.showLevel, cfg.showPrice, cfg.fill], [true, true, true, true]);
  assert.deepEqual([cfg.extendLeft, cfg.extendRight, cfg.log], [false, false, false]);
});

ok('a Fib whose labels were hidden with the old button keeps them hidden', () => {
  const cfg = fibOf({ type: 'fib', labels: false });
  assert.deepEqual([cfg.showLevel, cfg.showPrice], [false, false]);
  assert.equal(cfg.trend, true);
  assert.equal(fibOf({ type: 'fib', labels: false, fib: { showPrice: true } }).showPrice, true, 'saved options win');
});

ok('saved options that make no sense fall back instead of breaking the drawing', () => {
  assert.equal(fibOf({ fib: 'nope' }).levels.length, 7);
  assert.equal(fibOf({ fib: { trend: 'yes', fill: 1, log: null } }).trend, true);
  const cfg = fibOf({ fib: { levels: [{ value: NaN }, null, { value: 0.5, color: 'red' }, { value: '0.7' }, { value: 2, color: '#ABCDEF', on: false }, { value: 5000 }] } });
  assert.deepEqual(cfg.levels, [
    { value: 0.5, color: '#8E8A82', on: true },
    { value: 2, color: '#ABCDEF', on: false },
    { value: FIB_LIMITS.maxAbs, color: '#8E8A82', on: true },
  ]);
  assert.equal(fibOf({ fib: { levels: Array.from({ length: 80 }, (_, i) => ({ value: i })) } }).levels.length, FIB_LIMITS.maxLevels);
  assert.deepEqual(fibOf({ fib: { levels: [] } }).levels, [], 'removing every level is allowed');
});

ok('only the enabled levels are drawn, lowest value first', () => {
  const cfg = fibOf({ fib: { levels: [{ value: 1 }, { value: 0.5, on: false }, { value: 0 }, { value: 2 }] } });
  assert.deepEqual(activeLevels(cfg).map((l) => l.value), [0, 1, 2]);
});

ok('a level is a share of the move from the second point to the first', () => {
  assert.equal(levelPrice(200, 100, 0), 100);
  assert.equal(levelPrice(200, 100, 1), 200);
  assert.equal(levelPrice(200, 100, 0.5), 150);
  assert.equal(levelPrice(200, 100, 1.618), 261.8);
  assert.equal(levelPrice(100, 200, 0.5), 150, 'a down move works the same way');
  assert.equal(levelPrice(200, 100, -0.5), 50, 'negative levels go the other way');
});

ok('on a log scale the levels are spaced by percentage', () => {
  near(levelPrice(200, 100, 0.5, true), Math.sqrt(200 * 100));
  near(levelPrice(200, 100, 0, true), 100);
  near(levelPrice(200, 100, 1, true), 200);
  near(levelPrice(200, 100, 2, true), 400, 1e-6);
  assert.equal(levelPrice(200, 0, 0.5, true), 100, 'a zero price cannot be logged: linear instead');
  assert.equal(levelPrice(-5, 10, 0.5, true), 2.5);
});

ok('a typed level can use a dot, a comma or a percentage', () => {
  assert.equal(parseLevel('0.5'), 0.5);
  assert.equal(parseLevel('0,5'), 0.5);
  assert.equal(parseLevel(' .618 '), 0.618);
  assert.equal(parseLevel('50%'), 0.5);
  assert.equal(parseLevel('61,8 %'), 0.618);
  assert.equal(parseLevel('-0.5'), -0.5);
  assert.equal(parseLevel('2'), 2);
  assert.equal(parseLevel('5000'), FIB_LIMITS.maxAbs);
  for (const bad of ['', '  ', 'abc', '1.2.3', '1e3', '--1', '%', null, undefined]) assert.equal(parseLevel(bad), null, String(bad));
});

ok('a level is shown without trailing zeros', () => {
  assert.deepEqual([0, 0.5, 0.618, 1.618, 3, 0.236000000001, 4.236].map(formatLevel), ['0', '0.5', '0.618', '1.618', '3', '0.236', '4.236']);
});

ok('the label shows the level number, the price, both or nothing', () => {
  assert.equal(labelText({ showLevel: true, showPrice: true }, 0.5, '123.4'), '0.5 (123.4)');
  assert.equal(labelText({ showLevel: true, showPrice: false }, 0.5, '123.4'), '0.5');
  assert.equal(labelText({ showLevel: false, showPrice: true }, 0.5, '123.4'), '123.4');
  assert.equal(labelText({ showLevel: false, showPrice: false }, 0.5, '123.4'), '');
});

ok('the panel edits return new options and leave the old ones alone', () => {
  const cfg = fibOf({});
  const a = setLevel(cfg, 3, { value: 0.55, color: '#112233', on: false });
  assert.deepEqual(a.levels[3], { value: 0.55, color: '#112233', on: false });
  assert.equal(cfg.levels[3].value, 0.5, 'the original is untouched');
  assert.equal(setLevel(cfg, 3, { value: NaN, color: 'blue' }).levels[3].value, 0.5, 'invalid edits are ignored');
  assert.equal(setLevel(cfg, 3, { color: 'blue' }).levels[3].color, '#4CAF50');
  assert.equal(setLevel(cfg, 99, { value: 1 }), cfg, 'no such level');
  assert.equal(removeLevel(cfg, 0).levels.length, 6);
  assert.equal(setOption(cfg, 'log', true).log, true);
  assert.equal(setOption(cfg, 'bogus', true), cfg);
  assert.equal(cfg.log, false);
});

ok('adding a level suggests the next usual extension, and stops at the limit', () => {
  let cfg = fibOf({});
  cfg = addLevel(cfg);
  assert.deepEqual(cfg.levels.at(-1), { value: 1.272, color: '#8E8A82', on: true });
  cfg = addLevel(cfg);
  assert.equal(cfg.levels.at(-1).value, 1.618);
  while (cfg.levels.length < FIB_LIMITS.maxLevels) cfg = addLevel(cfg);
  assert.equal(addLevel(cfg), cfg);
});

// --- drawing a Fib ------------------------------------------------------------------------------
function makeLayer() {
  const chart = { timeScale: () => ({
    coordinateToLogical: (x) => x / 10, logicalToCoordinate: (l) => l * 10, width: () => 800,
    getVisibleLogicalRange: () => ({ from: 0, to: 80 }),
  }) };
  const series = { coordinateToPrice: (y) => 100 - y / 10, priceToCoordinate: (p) => (100 - p) * 10 };
  const layer = new DrawingLayer({ formatPrice: (v) => String(+v.toFixed(2)) });
  layer.attached({ chart, series, requestUpdate() {} });
  layer.setBars(Array.from({ length: 100 }, (_, i) => ({ time: 1000 * i, open: 50, high: 60, low: 40, close: 55 })));
  layer.setContext('FIB', 1000);
  return layer;
}

/** Records what is drawn: each stroked line, each filled rectangle and each text. */
function recorder() {
  const out = { lines: [], rects: [], texts: [] };
  let strokeStyle = '', fillStyle = '', dash = [], align = '', start = null, end = null;
  const ctx = new Proxy({}, {
    get: (_, k) => ({
      setLineDash: (d) => { dash = d; },
      beginPath: () => { start = end = null; },
      moveTo: (x, y) => { start = [x, y]; },
      lineTo: (x, y) => { end = [x, y]; },
      stroke: () => { if (start && end) out.lines.push({ from: start, to: end, color: strokeStyle, dash }); },
      fillRect: (x, y, w, h) => out.rects.push({ x, y, w, h, color: fillStyle }),
      fillText: (text, x, y) => out.texts.push({ text, x, y, align, color: fillStyle }),
      measureText: (s) => ({ width: String(s).length * 7 }),
    }[k] ?? (() => {})),
    set: (_, k, v) => { if (k === 'strokeStyle') strokeStyle = v; if (k === 'fillStyle') fillStyle = v; if (k === 'textAlign') align = v; return true; },
  });
  return { ctx, out };
}

// First point at price 80 (y 200), second at 40 (y 600): level 0.5 is price 60, y 400.
const fib = (extra = {}) => ({ id: 'f', type: 'fib', color: '#8E8A82', p1: { time: 20000, price: 80 }, p2: { time: 60000, price: 40 }, ...extra });
const draw = (layer, d) => { const r = recorder(); layer._drawItem(r.ctx, d, { width: 800, height: 600 }, false); return r.out; };
const levelLines = (out) => out.lines.filter((l) => l.dash.length === 0);

ok('a Fib without options is drawn as before: 7 levels, labels, background and the dashed trend line', () => {
  const out = draw(makeLayer(), fib());
  const lines = levelLines(out);
  assert.equal(lines.length, 7);
  assert.deepEqual(lines.map((l) => Math.round(l.from[1] * 10) / 10), [600, 505.6, 447.2, 400, 352.8, 285.6, 200], 'one line per level, from p2 to p1');
  assert.ok(lines.every((l) => l.from[0] === 200 && l.to[0] === 600), 'between the two points');
  assert.equal(out.rects.length, 6, 'a band between each pair of levels');
  assert.deepEqual(out.texts.map((t) => t.text).slice(0, 2), ['0 (40)', '0.236 (49.44)']);
  assert.ok(out.texts.every((t) => t.align === 'right' && t.x === 194), 'labels to the left of the lines');
  const trend = out.lines.filter((l) => l.dash.length);
  assert.equal(trend.length, 1);
  assert.deepEqual([trend[0].from, trend[0].to], [[200, 200], [600, 600]]);
});

ok('levels typed by the user are drawn where they say, in their own colors', () => {
  const out = draw(makeLayer(), fib({ fib: { levels: [{ value: 0.5, color: '#FF0000' }, { value: 1.5, color: '#00FF00' }] } }));
  const lines = levelLines(out);
  assert.deepEqual(lines.map((l) => [l.from[1], l.color]), [[400, '#FF0000'], [0, '#00FF00']]);
  assert.deepEqual(out.texts.map((t) => t.text), ['0.5 (60)', '1.5 (100)']);
  assert.equal(out.rects.length, 1);
  assert.equal(out.rects[0].color, 'rgba(0,255,0,0.1)', 'a band takes the color of the level above it');
});

ok('a disabled level is not drawn, and does not cut a band in two', () => {
  const out = draw(makeLayer(), fib({ fib: { levels: [{ value: 0 }, { value: 0.5, on: false }, { value: 1 }] } }));
  assert.equal(levelLines(out).length, 2);
  assert.equal(out.rects.length, 1);
  assert.equal(out.rects[0].h, 400);
});

ok('the trend line, the background and each kind of label can be turned off', () => {
  const l = makeLayer();
  assert.equal(draw(l, fib({ fib: { trend: false } })).lines.filter((x) => x.dash.length).length, 0);
  assert.equal(draw(l, fib({ fib: { fill: false } })).rects.length, 0);
  assert.equal(draw(l, fib({ fib: { showPrice: false } })).texts[3].text, '0.5');
  assert.equal(draw(l, fib({ fib: { showLevel: false } })).texts[3].text, '60');
  assert.equal(draw(l, fib({ fib: { showLevel: false, showPrice: false } })).texts.length, 0);
  assert.equal(draw(l, fib({ labels: false })).texts.length, 0, 'labels hidden with the old button');
});

ok('lines can be extended to the left, to the right or both', () => {
  const l = makeLayer();
  const left = draw(l, fib({ fib: { extendLeft: true } }));
  assert.ok(levelLines(left).every((x) => x.from[0] === 0 && x.to[0] === 600));
  assert.ok(left.texts.every((t) => t.align === 'left' && t.x === 6), 'labels stay inside the chart');
  const right = draw(l, fib({ fib: { extendRight: true } }));
  assert.ok(levelLines(right).every((x) => x.from[0] === 200 && x.to[0] === 800));
  assert.ok(right.texts.every((t) => t.align === 'right' && t.x === 194));
  const both = draw(l, fib({ fib: { extendLeft: true, extendRight: true } }));
  assert.ok(levelLines(both).every((x) => x.from[0] === 0 && x.to[0] === 800));
  assert.ok(both.rects.every((r) => r.x === 0 && r.w === 800), 'the background follows the lines');
});

ok('on a log scale the levels sit at their percentage positions', () => {
  const d = fib({ p1: { time: 20000, price: 90 }, p2: { time: 60000, price: 10 }, fib: { levels: [{ value: 0.5 }], log: true } });
  const out = draw(makeLayer(), d);
  const y = (100 - Math.sqrt(90 * 10)) * 10;
  near(levelLines(out)[0].from[1], y, 1e-6);
  assert.equal(out.texts[0].text, `0.5 (${+Math.sqrt(900).toFixed(2)})`);
  const linear = draw(makeLayer(), { ...d, fib: { levels: [{ value: 0.5 }] } });
  near(levelLines(linear)[0].from[1], (100 - 50) * 10, 1e-6);
});

ok('a Fib is picked up by its lines, including where they were extended', () => {
  const l = makeLayer();
  const d = fib();
  l.items.push(d);
  assert.equal(l.hitTest(400, 403), 'f', 'on the 0.5 line');
  assert.equal(l.hitTest(400, 425), null, 'between lines');
  assert.equal(l.hitTest(700, 400), null, 'right of the drawing');
  d.fib = { extendRight: true };
  assert.equal(l.hitTest(700, 400), 'f');
  assert.equal(l.hitTest(100, 400), null);
  d.fib = { extendLeft: true };
  assert.equal(l.hitTest(100, 400), 'f');
  d.fib = { levels: [{ value: 0.5, on: false }] };
  assert.equal(l.hitTest(400, 400), null, 'a disabled level cannot be picked');
});

ok('options are saved with the drawing and edited through updateSelected', () => {
  const l = makeLayer();
  l.setTool('fib');
  l.handleClick({ point: { x: 200, y: 200 } });
  l.handleClick({ point: { x: 600, y: 600 } });
  const d = l.items.at(-1);
  assert.equal(d.fib, undefined, 'a new Fib starts with the default look');
  l.updateSelected({ fib: setOption(fibOf(d), 'extendRight', true) });
  assert.equal(JSON.parse(JSON.stringify(l.items.at(-1))).fib.extendRight, true);
  l.updateSelected({ fib: undefined, labels: undefined });
  assert.equal(fibOf(l.items.at(-1)).extendRight, false, 'reset');
});

console.log(`fib: ${n} checks passed`);
