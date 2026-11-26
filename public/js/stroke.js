// Line style (solid, dashed, dotted) and thickness for the line drawings. Pure functions, shared by
// the canvas renderer (drawings.js) and the drawing's toolbar (chart-view.js).

export const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
export const STROKE_WIDTH = { min: 1, max: 20, default: 2 };

/** Drawings whose line can be restyled: the line tools and the level lines. */
export const STROKE_TOOLS = new Set(['trend', 'ray', 'extended', 'arrow', 'channel', 'hline', 'hray', 'vline', 'avwap']);

/** Thickness a tool draws with until the user picks one (a vertical line has always been thinner). */
const DEFAULT_WIDTH = { vline: 1.5 };

/** A thickness the canvas can draw: a whole number of pixels from 1 to 20. */
export const clampWidth = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(STROKE_WIDTH.min, Math.min(STROKE_WIDTH.max, n)) : STROKE_WIDTH.default;
};

/** Canvas dash pattern for a style. Gaps grow with the thickness so thick lines stay readable. */
export function dashFor(style, width) {
  const k = Math.max(1, width);
  if (style === 'dashed') return [4 * k + 2, 3 * k + 1];
  if (style === 'dotted') return [k, 2 * k];
  return [];
}

/** { style, width, dash } of a drawing; anything missing or invalid (saved data) falls back to the default. */
export function strokeOf(d) {
  const style = STROKE_STYLES.includes(d?.style) ? d.style : 'solid';
  const fallback = DEFAULT_WIDTH[d?.type] ?? STROKE_WIDTH.default;
  const width = Number.isFinite(d?.width) ? Math.max(STROKE_WIDTH.min, Math.min(STROKE_WIDTH.max, d.width)) : fallback;
  return { style, width, dash: dashFor(style, width) };
}
