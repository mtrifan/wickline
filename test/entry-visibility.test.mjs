// The eye button in the legend: hiding an indicator hides everything it draws, and showing it brings
// everything back (public/js/entry-visibility.js, plus the hidden flag on the shaded bands and the
// trade lines in primitives.js). Run: node test/entry-visibility.test.mjs
import assert from 'node:assert/strict';
import { applyEntryVisibility, isHidden, setHiddenFlag, syncMarkers } from '../public/js/entry-visibility.js';
import { BandFill, TradeLines } from '../public/js/primitives.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

/** Records the options and markers it is given, like the chart library's series and price lines. */
const fake = () => ({ calls: [], applyOptions(o) { this.calls.push(o); }, setMarkers(m) { this.last = m; } });
const MARKERS = [{ time: 1, position: 'aboveBar', shape: 'circle', color: '#fff', text: 'a' }];
const TRADE_MARKERS = [{ time: 2, position: 'belowBar', shape: 'arrowUp', color: '#fff', text: '1' }];

function makeEntry(inst = { id: 'i1', type: 'script' }) {
  const prim = new BandFill(() => null, { color: 'red' });
  const lines = new TradeLines(() => ({ trades: [] }));
  return {
    inst,
    series: [{ api: fake() }, { api: fake() }],
    levelLines: [fake(), fake()],
    fillPrims: [{ prim }],
    markersApi: fake(), markerData: MARKERS,
    tradeMarkers: fake(), tradeMarkerData: TRADE_MARKERS,
    tradeLines: lines,
  };
}

ok('an indicator is shown unless it carries the hidden flag', () => {
  assert.equal(isHidden({}), false);
  assert.equal(isHidden(undefined), false);
  assert.equal(isHidden({ hidden: true }), true);
});

ok('the flag is saved only while hidden, so a shown indicator is saved as before', () => {
  const inst = { id: 'a' };
  setHiddenFlag(inst, true);
  assert.deepEqual(inst, { id: 'a', hidden: true });
  setHiddenFlag(inst, false);
  assert.deepEqual(inst, { id: 'a' });
  assert.ok(!('hidden' in inst));
});

ok('hiding takes away the lines, level lines, bands, trade lines and every marker', () => {
  const e = makeEntry({ id: 'i1', hidden: true });
  applyEntryVisibility(e);
  assert.ok(e.series.every(({ api }) => api.calls.at(-1).visible === false), 'series');
  assert.ok(e.levelLines.every((l) => l.calls.at(-1).lineVisible === false), 'level lines');
  assert.equal(e.fillPrims[0].prim.hidden, true, 'bands');
  assert.equal(e.tradeLines.hidden, true, 'trade lines');
  assert.deepEqual(e.markersApi.last, [], 'markers');
  assert.deepEqual(e.tradeMarkers.last, [], 'trade markers');
});

ok('showing it again brings all of it back, markers included', () => {
  const e = makeEntry({ id: 'i1', hidden: true });
  applyEntryVisibility(e);
  setHiddenFlag(e.inst, false);
  applyEntryVisibility(e);
  assert.ok(e.series.every(({ api }) => api.calls.at(-1).visible === true));
  assert.ok(e.levelLines.every((l) => l.calls.at(-1).lineVisible === true));
  assert.equal(e.fillPrims[0].prim.hidden, false);
  assert.equal(e.tradeLines.hidden, false);
  assert.deepEqual(e.markersApi.last, MARKERS);
  assert.deepEqual(e.tradeMarkers.last, TRADE_MARKERS);
});

ok('markers that arrive while hidden are kept for later, not drawn', () => {
  const e = makeEntry({ id: 'i1', hidden: true });
  e.markerData = [{ ...MARKERS[0], text: 'new' }];
  syncMarkers(e);
  assert.deepEqual(e.markersApi.last, []);
  setHiddenFlag(e.inst, false);
  syncMarkers(e);
  assert.equal(e.markersApi.last[0].text, 'new');
});

ok('an indicator with nothing but lines (no bands, levels or markers) hides without trouble', () => {
  const e = { inst: { id: 'x', hidden: true }, series: [{ api: fake() }] };
  applyEntryVisibility(e);
  assert.equal(e.series[0].api.calls.at(-1).visible, false);
  assert.doesNotThrow(() => applyEntryVisibility({ inst: { id: 'y' } }));
});

ok('hidden bands and trade lines draw nothing, and ask the chart to redraw', () => {
  let requested = 0;
  const target = { used: 0, useMediaCoordinateSpace() { this.used++; } };
  const chart = { timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 10 }), logicalToCoordinate: (i) => i }) };
  const series = { priceToCoordinate: (p) => p };

  const band = new BandFill(() => ({ a: [1, 2, 3], b: [2, 3, 4] }), { color: 'red' });
  band.attached({ chart, series, requestUpdate: () => { requested++; } });
  band.draw(target);
  assert.equal(target.used, 1, 'shown: drawn');
  band.setHidden(true);
  band.draw(target);
  assert.equal(target.used, 1, 'hidden: not drawn');
  assert.equal(requested, 1, 'and the chart is told to repaint');

  const lines = new TradeLines(() => ({ trades: [{ ei: 1, xi: 3, ep: 1, xp: 2, win: true }] }));
  lines.attached({ chart, series, requestUpdate: () => { requested++; } });
  lines.draw(target);
  assert.equal(target.used, 2);
  lines.setHidden(true);
  lines.draw(target);
  assert.equal(target.used, 2);
  lines.setHidden(false);
  lines.draw(target);
  assert.equal(target.used, 3);
});

console.log(`entry visibility: ${n} checks passed`);
