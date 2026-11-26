// Fibonacci retracement settings. Pure functions: the saved shape of a Fib drawing's options, the
// price of a level (linear or on a log scale), reading and showing a level typed by the user, and the
// edits the settings panel makes. fib-panel.js draws the panel; drawings.js draws the levels.
//
// A Fib drawing keeps its options in `d.fib`:
//   { levels: [{ value, color, on }], trend, showLevel, showPrice, fill, extendLeft, extendRight, log }
// A drawing without `d.fib` (every Fib saved before these options existed) has the default look.

export const FIB_DEFAULT_LEVELS = [
  { value: 0, color: '#8E8A82' }, { value: 0.236, color: '#EC5246' }, { value: 0.382, color: '#FF9800' },
  { value: 0.5, color: '#4CAF50' }, { value: 0.618, color: '#34B886' }, { value: 0.786, color: '#00BCD4' },
  { value: 1, color: '#8E8A82' },
];

export const FIB_OPTIONS = ['trend', 'showLevel', 'showPrice', 'fill', 'extendLeft', 'extendRight', 'log'];
const OPTION_DEFAULTS = { trend: true, showLevel: true, showPrice: true, fill: true, extendLeft: false, extendRight: false, log: false };

export const FIB_LIMITS = { maxLevels: 24, maxAbs: 1000 };
const NEW_LEVEL_COLOR = '#8E8A82';
/** Suggested values for "add level", in the order traders reach for them. */
const EXTENSIONS = [1.272, 1.618, 2, 2.618, 3.618, 4.236];

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const clampValue = (v) => Math.max(-FIB_LIMITS.maxAbs, Math.min(FIB_LIMITS.maxAbs, v));

/**
 * The options of a Fib drawing, complete and safe to use: whatever is missing or invalid in the saved
 * data falls back to the default. A Fib whose labels were hidden with the old labels button keeps
 * them hidden until the user changes them.
 */
export function fibOf(d) {
  const saved = d?.fib && typeof d.fib === 'object' ? d.fib : {};
  const cfg = {};
  const legacyHidden = d?.labels === false;
  for (const key of FIB_OPTIONS) {
    const fallback = legacyHidden && (key === 'showLevel' || key === 'showPrice') ? false : OPTION_DEFAULTS[key];
    cfg[key] = typeof saved[key] === 'boolean' ? saved[key] : fallback;
  }
  const levels = Array.isArray(saved.levels)
    ? saved.levels.filter((l) => l && Number.isFinite(l.value)).slice(0, FIB_LIMITS.maxLevels)
      .map((l) => ({ value: clampValue(l.value), color: isColor(l.color) ? l.color : NEW_LEVEL_COLOR, on: l.on !== false }))
    : null;
  cfg.levels = levels ?? FIB_DEFAULT_LEVELS.map((l) => ({ ...l, on: true }));
  return cfg;
}

/** The levels to draw: the enabled ones, from the lowest value to the highest. */
export const activeLevels = (cfg) => cfg.levels.filter((l) => l.on).sort((a, b) => a.value - b.value);

/**
 * Price at a level. value 0 is the drawing's second point and 1 the first (so 0.618 is a 61.8% retracement
 * of the move from p2 to p1, as the tool has always drawn it). On a log scale the levels are spaced by
 * percentage, which is how they look on a chart in log scale; that needs both prices above zero.
 */
export function levelPrice(price1, price2, value, log = false) {
  if (log && price1 > 0 && price2 > 0) return Math.exp(Math.log(price2) + (Math.log(price1) - Math.log(price2)) * value);
  return price2 + (price1 - price2) * value;
}

/** A level typed by the user: "0.5", "0,5" (decimal comma) or "50%". Returns null when it isn't a number. */
export function parseLevel(text) {
  let s = String(text ?? '').trim().replace(',', '.');
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1).trim();
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s) / (percent ? 100 : 1);
  return Number.isFinite(n) ? clampValue(Math.round(n * 1e6) / 1e6) : null;
}

/** A level as shown on the chart and in the panel: 0.5, 0.618, 1.618. */
export const formatLevel = (value) => String(+Number(value).toFixed(4));

/** The text next to a level's line, from the options: "0.5 (123.45)", "0.5", "123.45" or nothing. */
export function labelText(cfg, value, priceText) {
  if (cfg.showLevel && cfg.showPrice) return `${formatLevel(value)} (${priceText})`;
  if (cfg.showLevel) return formatLevel(value);
  if (cfg.showPrice) return priceText;
  return '';
}

// --- edits made by the settings panel; each returns a new options object --------------------------

export function setLevel(cfg, index, patch) {
  if (!cfg.levels[index]) return cfg;
  const next = { ...cfg.levels[index] };
  if ('value' in patch && Number.isFinite(patch.value)) next.value = clampValue(patch.value);
  if ('color' in patch && isColor(patch.color)) next.color = patch.color;
  if ('on' in patch) next.on = !!patch.on;
  return { ...cfg, levels: cfg.levels.map((l, i) => (i === index ? next : l)) };
}

export function addLevel(cfg) {
  if (cfg.levels.length >= FIB_LIMITS.maxLevels) return cfg;
  const have = new Set(cfg.levels.map((l) => l.value));
  const value = EXTENSIONS.find((v) => !have.has(v)) ?? 0;
  return { ...cfg, levels: [...cfg.levels, { value, color: NEW_LEVEL_COLOR, on: true }] };
}

export function removeLevel(cfg, index) {
  return { ...cfg, levels: cfg.levels.filter((_, i) => i !== index) };
}

export function setOption(cfg, key, on) {
  return FIB_OPTIONS.includes(key) ? { ...cfg, [key]: !!on } : cfg;
}
