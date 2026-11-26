// Drawing tools: Shift snaps lines to horizontal (0°) while placing or dragging, and the magnet
// snaps drawing points to a bar's open, high, low or close. Run: node test/drawings.test.mjs
import assert from 'node:assert/strict';
import { DrawingLayer, MAGNET_MODES, SYMBOL_SIZE, TOOLS, anchoredVwap, isSymbol } from '../public/js/drawings.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

// A chart where x = bar * 10 (one bar every 10 px) and y = (100 - price) * 10.
function makeLayer() {
  const chart = { timeScale: () => ({
    coordinateToLogical: (x) => x / 10,
    logicalToCoordinate: (l) => l * 10,
    width: () => 800,
  }) };
  const series = { coordinateToPrice: (y) => 100 - y / 10, priceToCoordinate: (p) => (100 - p) * 10 };
  const layer = new DrawingLayer({ formatPrice: (v) => String(v) });
  layer.attached({ chart, series, requestUpdate() {} });
  // Every bar: open 50, high 60, low 40, close 55 (at y = 500, 400, 600, 450).
  layer.setBars(Array.from({ length: 100 }, (_, i) => ({ time: 1000 * i, open: 50, high: 60, low: 40, close: 55 })));
  layer.setContext('TEST', 1000);
  return layer;
}

/** A canvas context that records its calls. */
function recorder() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 8 })
      : k === 'roundRect' ? undefined : (...a) => calls.push([k, ...a])),
    set: (_, k, v) => { calls.push(['set', k, v]); return true; },
  });
  return { ctx, calls };
}

const place = (layer, tool, a, b, shift = false) => {
  layer.setTool(tool);
  layer.handleClick({ point: a });
  layer.handleClick({ point: b, shift });
  return layer.items.at(-1);
};

ok('Shift while placing a trend line keeps the preview at 0°', () => {
  const l = makeLayer();
  l.setTool('trend');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleMove({ point: { x: 500, y: 700 }, sourceEvent: { shiftKey: true } });
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  assert.equal(l.pending.p2.time, 50000, 'the end still follows the pointer in time');
  l.handleMove({ point: { x: 500, y: 700 }, sourceEvent: { shiftKey: false } });
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
});

ok('the second click with Shift places a perfectly horizontal line', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, true);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p2.time, 60000);
});

ok('without Shift the line is left as drawn', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, false);
  assert.notEqual(d.p2.price, d.p1.price);
});

ok('pressing and releasing Shift re-applies it without moving the mouse', () => {
  const l = makeLayer();
  l.setTool('ray');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleMove({ point: { x: 400, y: 600 } });
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
  l.setShift(true);
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  l.setShift(false);
  assert.notEqual(l.pending.p2.price, l.pending.p1.price);
});

ok('Shift applies to ray, extended line and arrow, not to a rectangle', () => {
  for (const tool of ['ray', 'extended', 'arrow']) {
    const d = place(makeLayer(), tool, { x: 100, y: 300 }, { x: 600, y: 120 }, true);
    assert.equal(d.p2.price, d.p1.price, tool);
  }
  const r = place(makeLayer(), 'rect', { x: 100, y: 300 }, { x: 600, y: 120 }, true);
  assert.notEqual(r.p2.price, r.p1.price);
});

ok('a channel flattens its first side; the width click stays free', () => {
  const l = makeLayer();
  l.setTool('channel');
  l.handleClick({ point: { x: 100, y: 300 } });
  l.handleClick({ point: { x: 600, y: 120 }, shift: true });
  assert.equal(l.pending.p2.price, l.pending.p1.price);
  l.handleClick({ point: { x: 350, y: 500 }, shift: true });
  const d = l.items.at(-1);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p3.price, 100 - 500 / 10);
});

ok('Shift while dragging an end handle keeps it level with the other end', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 300 }, { x: 600, y: 120 }, false);
  assert.ok(l.beginDrag(600, 120), 'grabs the p2 handle');
  l.dragMove(700, 50, true);
  assert.equal(d.p2.price, d.p1.price);
  assert.equal(d.p2.time, 70000);
  l.dragMove(700, 50, false);
  assert.notEqual(d.p2.price, d.p1.price);
  l.endDrag();
});

// --- magnet ---------------------------------------------------------------------------
const click = (l, x, y) => { l.handleClick({ point: { x, y } }); return l.items.at(-1); };

ok('the magnet is off by default and ignores bad modes', () => {
  const l = makeLayer();
  assert.deepEqual(MAGNET_MODES, ['off', 'weak', 'strong']);
  assert.equal(l.magnet, 'off');
  l.setMagnet('nonsense');
  assert.equal(l.magnet, 'off');
  l.setTool('hline');
  assert.equal(click(l, 100, 430).p1.price, 57, 'untouched with the magnet off');
});

ok('strong magnet snaps to the nearest of open, high, low and close, however far', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.setTool('hline');
  assert.equal(click(l, 100, 430).p1.price, 55, 'closer to the close (y 450) than to the high (y 400)');
  l.setTool('hline');
  assert.equal(click(l, 100, 380).p1.price, 60, 'the high');
  l.setTool('hline');
  assert.equal(click(l, 100, 700).p1.price, 40, 'the low, even far below the bar');
  l.setTool('hline');
  assert.equal(click(l, 100, 495).p1.price, 50, 'the open');
});

ok('weak magnet snaps only when the pointer is close, and leaves the price alone otherwise', () => {
  const l = makeLayer();
  l.setMagnet('weak');
  l.setTool('hline');
  assert.equal(click(l, 100, 440).p1.price, 55, '10 px from the close');
  l.setTool('hline');
  assert.equal(click(l, 100, 425).p1.price, 57.5, '25 px from anything: unchanged');
});

ok('the magnet also snaps a point being dragged, but not a drawing moved as a whole', () => {
  const l = makeLayer();
  const d = place(l, 'trend', { x: 100, y: 450 }, { x: 600, y: 520 }, false);
  l.setMagnet('strong');
  assert.ok(l.beginDrag(600, 520), 'grabs the p2 handle');
  l.dragMove(700, 590);
  assert.equal(d.p2.price, 40, 'the handle snaps to the low');
  l.endDrag();
  // The line now runs (100, 450) → (700, 600); grab it in the middle and move it 45 px up.
  assert.ok(l.beginDrag(400, 525), 'grabs the line, not a handle');
  l.dragMove(400, 480);
  l.endDrag();
  assert.equal(d.p1.price, 59.5, 'moved by the pointer (+4.5), not snapped to a bar value');
});

ok('past the last bar there is nothing to snap to', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.setTool('hline');
  assert.equal(click(l, 2000, 430).p1.price, 57);
});

ok('Shift and the magnet work together: the first point snaps, the line is level', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  const d = place(l, 'trend', { x: 100, y: 430 }, { x: 600, y: 700 }, true);
  assert.equal(d.p1.price, 55);
  assert.equal(d.p2.price, 55);
});

ok('a ring marks where the magnet snaps while a tool is selected, and goes away after', () => {
  const l = makeLayer();
  l.setMagnet('strong');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.equal(l.hint, null, 'cursor tool: no ring');
  l.setTool('trend');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.deepEqual(l.hint, { time: 10000, price: 55 });
  l.handleMove({ point: undefined });
  assert.equal(l.hint, null, 'pointer left the chart');
  l.handleMove({ point: { x: 100, y: 430 } });
  l.setMagnet('off');
  assert.equal(l.hint, null, 'magnet turned off');
  l.handleMove({ point: { x: 100, y: 430 } });
  assert.equal(l.hint, null);
});

// Long/short positions: a click-click on one candle used to leave a box with no width (only its
// labels showing) that nothing could select or delete.
ok('a long placed with both clicks on one candle gets a ready-made size, target above, stop below', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 302, y: 501 });
  assert.ok(l.logicalFromTime(d.p2.time) - l.logicalFromTime(d.p1.time) >= 5, 'at least 5 bars wide');
  assert.ok(d.p2.price > d.p1.price, 'target above the entry');
  assert.ok(d.p3.price < d.p1.price, 'stop below the entry');
  assert.equal(l.hitTest(305, 500), d.id, 'it can be picked up');
});

ok('a short placed with one click-click points down', () => {
  const l = makeLayer();
  const d = place(l, 'short', { x: 300, y: 500 }, { x: 300, y: 500 });
  assert.ok(d.p2.price < d.p1.price && d.p3.price > d.p1.price);
});

ok('a long drawn as usual keeps the size it was drawn with', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 500, y: 300 });
  assert.equal(d.p2.time, 50000);
  assert.equal(d.p2.price, 70);
  assert.equal(d.p3.price, 30);
});

ok('a very thin position can still be selected (a few pixels of margin)', () => {
  const l = makeLayer();
  const d = place(l, 'long', { x: 300, y: 500 }, { x: 500, y: 300 });
  l.select(null);
  assert.equal(l.hitTest(296, 400), d.id, 'just left of the box');
  assert.equal(l.hitTest(250, 400), null, 'well outside it');
});

ok('while a long is being placed it previews (no stop yet) without errors', () => {
  const l = makeLayer();
  l.setTool('long');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.handleMove({ point: { x: 450, y: 350 } });
  assert.ok(l.pending && !l.pending.p3);
  assert.deepEqual(l._handles(l.pending).map(([h]) => h), ['p1', 'p2']);
});

ok('anchored VWAP: volume-weighted typical price from the anchor on; equal weights when there is no volume', () => {
  const bars = [
    { high: 12, low: 8, close: 10, volume: 100 }, // typical 10
    { high: 24, low: 18, close: 21, volume: 300 }, // typical 21
    { high: 30, low: 30, close: 30, volume: 0 }, // no volume: no weight
  ];
  assert.deepEqual(anchoredVwap(bars, 0), [10, (10 * 100 + 21 * 300) / 400, (10 * 100 + 21 * 300) / 400]);
  assert.deepEqual(anchoredVwap(bars, 1), [21, 21]);
  assert.deepEqual(anchoredVwap(bars.map((b) => ({ ...b, volume: 0 })), 0), [10, 15.5, 61 / 3]);
  assert.deepEqual(anchoredVwap(bars, 5), []);
});

ok('anchored VWAP drawing: one click anchors it at that bar; it can be picked up on its line, not off it', () => {
  const l = makeLayer(); // every bar's typical price: (60 + 40 + 55) / 3
  l.setTool('avwap');
  l.handleClick({ point: { x: 300, y: 200 } });
  const d = l.items.at(-1);
  assert.equal(d.type, 'avwap');
  const { from, values } = l._vwap(d);
  assert.equal(from, 30);
  assert.equal(values.length, 70);
  const y = (100 - 155 / 3) * 10;
  assert.ok(Math.abs(l._y(values[10]) - y) < 1e-9);
  l.select(null);
  assert.equal(l.hitTest(500, y + 2), d.id, 'on the line');
  assert.equal(l.hitTest(250, y), null, 'before the anchor');
  assert.equal(l.hitTest(500, y + 60), null, 'far from the line');
  const [[name, hx, hy]] = l._handles(d);
  assert.deepEqual([name, hx, Math.round(hy)], ['p1', 300, Math.round(y)]);
  assert.ok(!Object.keys(d).some((k) => k.startsWith('_vwap')), 'the cache is not saved with the drawing');
});

// --- arrow symbols -------------------------------------------------------------------------
ok('arrow symbols are one-point tools with a label and size', () => {
  assert.ok(isSymbol('arrowUp') && isSymbol('arrowDown') && !isSymbol('trend'));
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  assert.equal(d.type, 'arrowDown');
  assert.equal(d.text, '');
  assert.equal(d.size, SYMBOL_SIZE.default);
  assert.equal(l.tool, 'cursor', 'back to the cursor after placing');
  assert.equal(l.selectedId, d.id);
  assert.equal(l.focusText, true);
});

ok('the label and size can be edited, and size stays within its limits', () => {
  const l = makeLayer();
  l.setTool('arrowUp');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.updateSelected({ text: '17', size: 24 });
  assert.equal(l.selected.text, '17');
  assert.equal(l.selected.size, 24);
  l.updateSelected({ size: 999 });
  assert.equal(l.selected.size, SYMBOL_SIZE.max);
  l.updateSelected({ size: 1 });
  assert.equal(l.selected.size, SYMBOL_SIZE.min);
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 400, y: 500 } });
  assert.equal(l.items[1].size, SYMBOL_SIZE.min, 'the next symbol starts at the last size used');
});

ok('▼ sits above its price with the label on top; ▲ below with the label underneath', () => {
  const l = makeLayer();
  const down = l._symbolGeom({ type: 'arrowDown', size: 20 }, 300, 500);
  assert.ok(down.tipY < 500 && down.tailY < down.tipY && down.labelY < down.tailY);
  const up = l._symbolGeom({ type: 'arrowUp', size: 20 }, 300, 500);
  assert.ok(up.tipY > 500 && up.tailY > up.tipY && up.labelY > up.tailY);
});

ok('a symbol is selectable by clicking its arrow or label, and not far away', () => {
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  l.updateSelected({ text: 'Sell 13', size: 20 });
  const id = l.items[0].id;
  assert.equal(l.hitTest(300, 480), id, 'on the arrow');
  assert.equal(l.hitTest(300, 440), id, 'on the label');
  assert.equal(l.hitTest(300, 560), null);
  assert.equal(l.hitTest(600, 480), null);
});

ok('dragging a symbol moves it', () => {
  const l = makeLayer();
  l.setTool('arrowUp');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  assert.ok(l.beginDrag(300, 515));
  l.dragMove(400, 415);
  l.endDrag();
  assert.equal(d.p1.time, 40000);
  assert.equal(Math.round(d.p1.price), 60); // 50 + the 10 the pointer moved up
});

ok('drawing a symbol paints the arrow and the label, and survives a missing label', () => {
  const l = makeLayer();
  l.setTool('arrowDown');
  l.handleClick({ point: { x: 300, y: 500 } });
  const d = l.items[0];
  let r = recorder();
  l._drawItem(r.ctx, d, { width: 800, height: 600 }, false);
  assert.ok(r.calls.some((c) => c[0] === 'fill'));
  assert.ok(!r.calls.some((c) => c[0] === 'fillText'), 'no label, no text');
  l.updateSelected({ text: '13', size: 30 });
  r = recorder();
  l._drawItem(r.ctx, d, { width: 800, height: 600 }, true);
  const text = r.calls.find((c) => c[0] === 'fillText');
  assert.deepEqual(text.slice(0, 2), ['fillText', '13']);
  assert.ok(r.calls.some((c) => c[0] === 'set' && c[1] === 'font' && String(c[2]).includes('30px')));
  assert.ok(r.calls.some((c) => c[0] === 'arc'), 'selected: a handle is drawn');
});

ok('the tools are registered', () => {
  assert.equal(TOOLS.arrowUp.points, 1);
  assert.equal(TOOLS.arrowDown.points, 1);
});

console.log(`drawings: ${n} checks passed`);
