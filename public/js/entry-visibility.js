// Hiding an indicator without removing it (the eye button in the legend). An indicator draws more than
// its lines: level lines, shaded bands, markers and, for a strategy, trade lines and markers. This is
// the one place that knows how to show or hide all of it, so chart-view.js only flips the flag.
//
// An "entry" is chart-view's live indicator: { inst, series: [{ api }], levelLines, fillPrims: [{ prim }],
// markersApi, markerData, tradeMarkers, tradeMarkerData, tradeLines }. `inst.hidden` is what gets saved.

export const isHidden = (inst) => !!inst?.hidden;

/** Sets or clears the saved flag; a shown indicator carries no `hidden` field at all. */
export function setHiddenFlag(inst, hidden) {
  if (hidden) inst.hidden = true; else delete inst.hidden;
}

/** Markers are kept on the entry and sent to the chart only while the indicator is shown. */
export function syncMarkers(entry) {
  const shown = !isHidden(entry.inst);
  entry.markersApi?.setMarkers(shown ? entry.markerData ?? [] : []);
  entry.tradeMarkers?.setMarkers(shown ? entry.tradeMarkerData ?? [] : []);
}

/** Shows or hides everything the indicator draws, as its `hidden` flag says. */
export function applyEntryVisibility(entry) {
  const shown = !isHidden(entry.inst);
  for (const { api } of entry.series || []) api.applyOptions({ visible: shown });
  for (const line of entry.levelLines || []) line.applyOptions({ lineVisible: shown });
  for (const { prim } of entry.fillPrims || []) prim.setHidden(!shown);
  entry.tradeLines?.setHidden(!shown);
  syncMarkers(entry);
}
