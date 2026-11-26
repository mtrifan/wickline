// Line style and thickness of the line drawings: the pure helpers (stroke.js) and how the canvas
// renderer applies them. Run: node test/stroke.test.mjs
import assert from 'node:assert/strict';
import { STROKE_STYLES, STROKE_TOOLS, STROKE_WIDTH, clampWidth, dashFor, strokeOf } from '../public/js/stroke.js';
import { DrawingLayer } from '../public/js/drawings.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

ok('there are three styles, and the line and level tools can be restyled', () => {
  assert.deepEqual(STROKE_STYLES, ['solid', 'dashed', 'dotted']);
  for (const tool of ['trend', 'ray', 'extended', 'arrow', 'channel', 'hline', 'hray', 'vline']) assert.ok(STROKE_TOOLS.has(tool), tool);
  for (const tool of ['rect', 'fib', 'text', 'measure', 'long', 'short']) assert.ok(!STROKE_TOOLS.has(tool), tool);
});

ok('thickness is a whole number of pixels between 1 and 20', () => {
  assert.equal(clampWidth(3), 3);
  assert.equal(clampWidth('7'), 7);
  assert.equal(clampWidth(2.6), 3);
  assert.equal(clampWidth(0), STROKE_WIDTH.min);
  assert.equal(clampWidth(-4), STROKE_WIDTH.min);
  assert.equal(clampWidth(500), STROKE_WIDTH.max);
  assert.equal(clampWidth('abc'), STROKE_WIDTH.default);
  assert.equal(clampWidth(NaN), STROKE_WIDTH.default);
});

ok('a solid line has no dash; dashes and dots grow with the thickness', () => {
  assert.deepEqual(dashFor('solid', 5), []);
  assert.deepEqual(dashFor('dashed', 1), [6, 4]);
  assert.deepEqual(dashFor('dashed', 4), [18, 13]);
  assert.deepEqual(dashFor('dotted', 1), [1, 2]);
  assert.deepEqual(dashFor('dotted', 4), [4, 8]);
  assert.deepEqual(dashFor('anything else', 4), []);
});

ok('a drawing without style or thickness keeps its old look', () => {
  assert.deepEqual(strokeOf({ type: 'trend' }), { style: 'solid', width: 2, dash: [] });
  assert.equal(strokeOf({ type: 'vline' }).width, 1.5, 'vertical lines were always a little thinner');
  assert.deepEqual(strokeOf(undefined), { style: 'solid', width: 2, dash: [] });
});

ok('saved values that make no sense fall back instead of breaking the drawing', () => {
  assert.equal(strokeOf({ type: 'trend', style: 'wavy' }).style, 'solid');
  assert.equal(strokeOf({ type: 'trend', width: 'thick' }).width, 2);
  assert.equal(strokeOf({ type: 'trend', width: 1000 }).width, STROKE_WIDTH.max);
  assert.equal(strokeOf({ type: 'trend', width: -3 }).width, STROKE_WIDTH.min);
  assert.deepEqual(strokeOf({ type: 'trend', style: 'dotted', width: 3 }).dash, [3, 6]);
});

// --- the renderer ----------------------------------------------------------------------------
function makeLayer() {
  const chart = { timeScale: () => ({
    coordinateToLogical: (x) => x / 10, logicalToCoordinate: (l) => l * 10, width: () => 800,
    getVisibleLogicalRange: () => ({ from: 0, to: 80 }),
  }) };
  const series = { coordinateToPrice: (y) => 100 - y / 10, priceToCoordinate: (p) => (100 - p) * 10 };
  const layer = new DrawingLayer({ formatPrice: String });
  layer.attached({ chart, series, requestUpdate() {} });
  layer.setBars(Array.from({ length: 100 }, (_, i) => ({ time: 1000 * i, open: 50, high: 60, low: 40, close: 55 })));
  layer.setContext('STROKE', 1000);
  return layer;
}

/** A canvas context that records the line width and dash in force at each stroke. */
function recorder() {
  const strokes = [];
  let width = 1, dash = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'setLineDash' ? (d) => { dash = d; }
      : k === 'stroke' ? () => strokes.push({ width, dash })
      : k === 'measureText' ? (s) => ({ width: String(s).length * 7 })
      : k === 'roundRect' ? undefined : () => {}),
    set: (_, k, v) => { if (k === 'lineWidth') width = v; return true; },
  });
  return { ctx, strokes };
}

const draw = (layer, d) => { const r = recorder(); layer._drawItem(r.ctx, d, { width: 800, height: 600 }, false); return r.strokes; };
const point = (x, price) => ({ time: x * 100, price });

ok('every line tool is drawn with the style and thickness of the drawing', () => {
  const l = makeLayer();
  for (const type of ['trend', 'ray', 'extended', 'arrow', 'hline', 'hray', 'vline']) {
    const strokes = draw(l, { id: type, type, p1: point(10, 50), p2: point(40, 55), color: '#fff', style: 'dashed', width: 5 });
    assert.ok(strokes.length >= 1, `${type} was drawn`);
    assert.ok(strokes.every((s) => s.width === 5 && s.dash.join() === '22,16'), `${type}: ${JSON.stringify(strokes)}`);
  }
});

ok('without a style the lines are solid and as thick as before', () => {
  const l = makeLayer();
  assert.deepEqual(draw(l, { id: 'a', type: 'trend', p1: point(10, 50), p2: point(40, 55), color: '#fff' }), [{ width: 2, dash: [] }]);
  assert.deepEqual(draw(l, { id: 'b', type: 'vline', p1: point(10, 50), p2: point(10, 50), color: '#fff' }), [{ width: 1.5, dash: [] }]);
});

ok('a channel draws both edges in the chosen style; its dashed midline stays as it was', () => {
  const l = makeLayer();
  const s = draw(l, { id: 'c', type: 'channel', p1: point(10, 50), p2: point(40, 55), p3: point(25, 60), color: '#fff', style: 'dotted', width: 3 });
  assert.equal(s.length, 3);
  assert.deepEqual(s.slice(0, 2), [{ width: 3, dash: [3, 6] }, { width: 3, dash: [3, 6] }]);
  assert.deepEqual(s[2], { width: 1, dash: [4, 4] });
});

ok('a drawing that is not a line is not affected by a stray style in saved data', () => {
  const l = makeLayer();
  const s = draw(l, { id: 'r', type: 'rect', p1: point(10, 50), p2: point(40, 55), color: '#fff', style: 'dashed', width: 9 });
  assert.ok(s.every((x) => x.dash.length === 0));
});

ok('style and thickness are saved with the drawing and edited from the toolbar', () => {
  const l = makeLayer();
  l.setTool('trend');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleClick({ point: { x: 500, y: 200 } });
  const d = l.items.at(-1);
  assert.equal(d.style, undefined, 'new lines start with the default look');
  l.updateSelected({ style: 'dotted', width: 4 });
  assert.equal(d.style, 'dotted');
  assert.equal(d.width, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(l.items)).at(-1).style, 'dotted');
});

console.log(`stroke: ${n} checks passed`);
