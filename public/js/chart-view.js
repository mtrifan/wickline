// One chart cell: its own symbol, timeframe, data feed, indicators (built-in and scripts),
// compare symbols, drawings, alerts lines and legend. The app shell creates one per layout cell.
// Bar replay also lives here: the chart shows history up to a chosen candle and steps forward.

import * as LWC from '../vendor/lightweight-charts.mjs';
import { createFeed, tfById, parseSymbol, displayTicker, isCryptoSymbol, sourceName } from './datafeed.js';
import { tfIdOf } from './timeframes.js';
import { INDICATORS, PALETTE, UP, DOWN, defaultParams, indicatorLabel, optionLabel, heikinAshi, heikinAshiAt } from './indicators.js';
import { DrawingLayer, DRAW_COLORS, SYMBOL_SIZE, TOOLS, isSymbol } from './drawings.js';
import { applyEntryVisibility, isHidden, setHiddenFlag, syncMarkers } from './entry-visibility.js';
import { closeFibPanel, fibPanelId, openFibPanel } from './fib-panel.js';
import { closePointEditor, editablePoints, openPointEditor, pointEditorId, refreshPointEditor } from './point-editor.js';
import { STROKE_STYLES, STROKE_TOOLS, STROKE_WIDTH, clampWidth, strokeOf } from './stroke.js';
import { BandFill, Countdown, TradeLines } from './primitives.js';
import { engine, scriptStore } from './scripts.js';
import { canRunCommunity } from './community.js';
import { LIMITS, coerceParams, safeColor } from './script-sanitize.js';
import { esc, formatNumber, formatVolume, uid, withAlpha, fixed, decimalComma } from './util.js';
import { t, lang, locale } from './i18n.js';

const DAY = 86400;
const FLUSH_MS = 100;        // live redraws at most ~10 times per second per chart
const SCRIPT_MIN_MS = 250;   // user scripts re-run at most ~4 times per second per chart
const COMPARE_COLORS = ['#FF9800', '#E040FB', '#00BCD4', '#FFEB3B', '#4CAF50', '#F06292'];

export const CHART_TYPES = ['candles', 'hollow', 'heikin', 'bars', 'line', 'linemarkers', 'stepline', 'area', 'baseline', 'columns']
  .map((id) => [id, t(`chart.type.${id}`)]);

export const THEMES = {
  dark: {
    bg: '#0F1012', text: '#A9A49B', grid: 'rgba(36, 39, 43, 0.5)', border: '#24272B',
    crosshair: '#7A766F', label: '#2B2E33', separator: '#24272B', strong: '#D9D5CD', level: '#8E8A82',
  },
  light: {
    bg: '#FCFBF8', text: '#1E1B17', grid: 'rgba(36, 39, 43, 0.07)', border: '#E7E2D8',
    crosshair: '#9A948A', label: '#0F1012', separator: '#E7E2D8', strong: '#0F1012', level: '#9A948A',
  },
};

let currentTheme = 'dark';
const VIEWS = new Set();
// Test hook for the end-to-end tests (test/e2e.mjs), only when the page is opened with ?e2e.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("e2e")) window.__wickline = { views: () => [...VIEWS] };
export const currentThemeName = () => currentTheme;

function chartOptions(themeName) {
  const t = THEMES[themeName];
  return {
    layout: {
      background: { type: LWC.ColorType.Solid, color: t.bg },
      textColor: t.text,
      fontSize: 12,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif',
      panes: { separatorColor: t.separator, separatorHoverColor: alpha(CANDLES.accent, 0.3), enableResize: true },
    },
    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: t.crosshair, labelBackgroundColor: t.label },
      horzLine: { color: t.crosshair, labelBackgroundColor: t.label },
    },
    rightPriceScale: { borderColor: t.border },
    timeScale: { borderColor: t.border },
  };
}

// Series colors of the current theme (see theme.js).
let CANDLES = { up: UP, down: DOWN, wickUp: UP, wickDown: DOWN, line: '#E5484D', accent: '#E5484D' };
const alpha = withAlpha;

/** Applies a full palette from theme.js: chart colors for a mode, plus candle and line colors. */
export function setChartPalette(mode, chart, candles) {
  currentTheme = mode === 'light' ? 'light' : 'dark';
  THEMES[currentTheme] = { ...THEMES[currentTheme], ...chart };
  const changed = JSON.stringify(candles) !== JSON.stringify(CANDLES);
  CANDLES = { ...candles };
  for (const v of VIEWS) v.restyle(changed);
}

// Re-run scripts on every chart when a script is saved or deleted.
scriptStore.onChange((id) => {
  for (const v of VIEWS) {
    for (const entry of v.live.values()) {
      if (entry.script && (id === null || entry.inst.scriptId === id)) { entry.sig = null; entry.halted = false; v.runScript(entry, true); }
    }
  }
});

export const defaultIndicators = () => [
  { id: uid(), type: 'volume', params: {} },
  { id: uid(), type: 'ema', params: { length: 21, source: 'close' }, colors: { ma: '#F2A33A' } },
  { id: uid(), type: 'rsi', params: { length: 14, source: 'close' } },
];

/** A saved indicator, checked: it comes from storage or a pop-out link, so nothing in it is trusted. */
function normalizeIndicator(i) {
  const colors = {};
  if (i.colors && typeof i.colors === 'object') {
    for (const [k, c] of Object.entries(i.colors)) if (/^[A-Za-z_][\w]{0,40}$/.test(k) && safeColor(c, null)) colors[k] = safeColor(c);
  }
  const out = { ...i, id: typeof i.id === 'string' && i.id ? i.id.slice(0, 64) : uid(), colors };
  setHiddenFlag(out, i.hidden === true); // hidden from the legend's eye button
  if (i.type === 'script') {
    // The script declares its settings when it runs (applyScriptResult coerces them then); keep plain values.
    const params = {};
    for (const [k, v] of Object.entries(i.params && typeof i.params === 'object' ? i.params : {})) {
      if (/^in\d{1,3}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) {
        params[k] = typeof v === 'string' ? v.slice(0, LIMITS.text) : v;
      }
    }
    out.scriptId = String(i.scriptId).slice(0, 64);
    out.params = params;
    if (out.strategy != null && typeof out.strategy !== 'object') delete out.strategy;
  } else {
    out.params = coerceParams(i.params, INDICATORS[i.type].params);
  }
  return out;
}

export function normalizeChartState(s = {}) {
  return {
    symbol: typeof s.symbol === 'string' && s.symbol ? s.symbol.slice(0, 100) : 'BINANCE:BTCUSDT',
    tf: tfIdOf(s.tf) || '1h', // any timeframe (timeframes.js); saved ids stay as they are
    chartType: CHART_TYPES.some(([k]) => k === s.chartType) ? s.chartType : 'candles',
    logScale: !!s.logScale,
    indicators: (Array.isArray(s.indicators) ? s.indicators : defaultIndicators())
      .filter((i) => i && typeof i === 'object' && (i.type === 'script' ? (typeof i.scriptId === 'string' && i.scriptId) : Object.hasOwn(INDICATORS, i.type)))
      .map(normalizeIndicator),
    compares: Array.isArray(s.compares)
      ? s.compares.filter((c) => typeof c?.symbol === 'string' && c.symbol)
        .map((c) => ({ ...c, symbol: c.symbol.slice(0, 100), color: safeColor(c.color, COMPARE_COLORS[0]) }))
      : [],
  };
}

/** Deep copy of a chart state with fresh indicator ids (for new cells and pop-outs). */
export function cloneChartState(s, overrides = {}) {
  const copy = JSON.parse(JSON.stringify(s));
  copy.indicators = copy.indicators.map((i) => ({ ...i, id: uid() }));
  return { ...copy, ...overrides };
}

const ICON_GEAR = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.3 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.3-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="14" height="14"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_CODE = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MAX = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_POP = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/></svg>';
const ICON_STEP = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 5.5v13l9-6.5z" fill="currentColor"/><path d="M16.5 5.5h2.5v13h-2.5z" fill="currentColor"/></svg>';
const ICON_CUT = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v18" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.5 2.5"/><path d="M5 9l-2 3 2 3M19 9l2 3-2 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const REPLAY_SPEEDS = [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [3, '3×'], [5, '5×'], [10, '10×']];
const ICON_TO_LATEST = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 7l5 5-5 5M12 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const eyeIcon = (extra = '') => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${EYE}${extra}</svg>`;
const ICON_EYE = eyeIcon();
const ICON_EYE_OFF = eyeIcon('<path d="M4 4l16 16"/>');
// One sample of each line style, for the buttons in the drawing's toolbar.
const STROKE_ICONS = {
  solid: '<path d="M3 12h18"/>',
  dashed: '<path d="M2.5 12h4M10 12h4M17.5 12h4"/>',
  dotted: '<path d="M3.5 12h.01M8.5 12h.01M13.5 12h.01M18.5 12h.01" stroke-width="3"/>',
};
const strokeIcon = (style) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${STROKE_ICONS[style]}</svg>`;
const ICON_EDIT = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_LABELS = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7V5h11v2M9.5 5v13M7.5 18h4M14 12h6M17 12v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * A series' price format with p decimals. Lightweight Charts writes its scale with a dot, so where
 * the UI language writes a decimal comma (es, pt-BR) the scale and crosshair use one too.
 */
const priceFormatOf = (p) => (decimalComma
  ? { type: 'custom', minMove: 1 / 10 ** p, formatter: (v) => fixed(v, p) }
  : { type: 'price', precision: p, minMove: 1 / 10 ** p });

const sameBar = (a, b) => a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

function plotColor(inst, plot) {
  return inst.colors?.[plot.key] || (plot.color === 'auto' ? PALETTE[0] : plot.color) || '#4FA3F7';
}

/** Turns a script run result into an indicator definition the chart understands. */
function scriptDef(res) {
  return {
    name: res.meta.name,
    short: res.meta.short || res.meta.name,
    overlay: res.meta.overlay,
    precision: res.meta.precision ?? undefined,
    script: true,
    strategy: !!res.meta.strategy,
    params: res.inputs.map((i) => ({
      key: i.key, label: i.title, def: i.def,
      type: i.type === 'number' ? undefined : i.type,
      options: i.options,
      min: i.min ?? -1e12, max: i.max ?? 1e12,
      step: i.step ?? (Number.isInteger(i.def) ? 1 : 0.01),
    })),
    plots: res.plots.map((p) => ({ key: p.key, title: p.title, color: p.color, colorsArr: p.colors, type: p.type, width: p.width })),
    levels: res.hlines.map((h) => h.price),
    levelColors: res.hlines.map((h) => h.color),
    fills: res.fills.map((f) => ({ ...f, consts: res.consts })),
  };
}

// ---------------------------------------------------------------------------
// Indicator settings popover (one shared element for all charts)
// ---------------------------------------------------------------------------

const settings = { el: null, view: null, id: null };

function initSettings() {
  if (settings.el) return;
  settings.el = document.getElementById('ind-settings');
  const onEdit = (e) => settings.view?.onSettingsInput(settings.id, e.target);
  settings.el.addEventListener('input', onEdit);
  settings.el.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') onEdit(e); });
  settings.el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeSettings();
    if (act === 'defaults') settings.view?.resetIndicator(settings.id);
  });
  document.addEventListener('mousedown', (e) => {
    if (!settings.el.hidden && !settings.el.contains(e.target) && !e.target.closest('[data-act="settings"]')) closeSettings();
  });
}

export function closeSettings() {
  if (settings.el) settings.el.hidden = true;
  settings.view = null;
  settings.id = null;
}

export const settingsOpen = () => !!settings.el && !settings.el.hidden;

// ---------------------------------------------------------------------------

export class ChartView {
  /**
   * hooks: onActivate, onChange, onStatus, onUpdate, onCrosshair, onToolChange, onMaximize,
   *        onPopout, onSearch, onEditScript, onCreateAlert — each called with (view, ...)
   */
  constructor(host, state, hooks = {}) {
    initSettings();
    this.state = normalizeChartState(state);
    this.hooks = hooks;

    this.el = document.createElement('div');
    this.el.className = 'cell';
    this.el.innerHTML = `
      <div class="chart-host"></div>
      <div class="legend">
        <div class="lg-title"><span class="lg-name"></span><span class="lg-meta"></span>
          <div class="qt" hidden>
            <button class="qt-sell" data-qt="sell" title="${t('chart.qtSellTitle')}"><small>${t('common.sell')}</small><b class="qt-px">—</b></button>
            <input class="qt-qty" type="number" min="0" step="any" aria-label="${t('chart.quantity')}" title="${t('chart.quantity')}">
            <button class="qt-buy" data-qt="buy" title="${t('chart.qtBuyTitle')}"><small>${t('common.buy')}</small><b class="qt-px">—</b></button>
          </div>
        </div>
        <div class="lg-ohlc"></div>
        <div class="lg-ind"></div>
      </div>
      <div class="pane-legends"></div>
      <div class="draw-bar" hidden>
        <div class="db-colors">${DRAW_COLORS.map((c) => `<button data-color="${c}" style="--c:${c}" aria-label="${t('chart.colorAria', { color: c })}"></button>`).join('')}</div>
        <div class="db-stroke" hidden>
          ${STROKE_STYLES.map((s) => `<button data-stroke="${s}" title="${t(`draw.style.${s}`)}" aria-label="${t(`draw.style.${s}`)}">${strokeIcon(s)}</button>`).join('')}
          <label class="db-width" title="${t('draw.width')}"><input type="number" min="${STROKE_WIDTH.min}" max="${STROKE_WIDTH.max}" step="1" aria-label="${t('draw.width')}">px</label>
        </div>
        <input class="db-text" placeholder="${t('draw.tool.text')}" maxlength="80" hidden>
        <label class="db-size" title="${t('chart.symbolSize')}" hidden>
          <input type="range" min="${SYMBOL_SIZE.min}" max="${SYMBOL_SIZE.max}" step="1" aria-label="${t('chart.symbolSize')}"><output></output>
        </label>
        <button data-db="alert" title="${t('chart.alertAtPrice')}" hidden>${ICON_BELL}</button>
        <button data-db="labels" class="db-labels" hidden>${ICON_LABELS}</button>
        <button data-db="edit" title="${t('draw.edit')}" aria-label="${t('draw.edit')}" hidden>${ICON_EDIT}</button>
        <button data-db="fib" title="${t('common.settings')}" aria-label="${t('common.settings')}" hidden>${ICON_GEAR}</button>
        <button data-db="delete" title="${t('chart.deleteDel')}">${ICON_TRASH}</button>
      </div>
      <div class="rp-pick" hidden><div class="rp-dim"></div></div>
      <div class="rp-banner" hidden>
        <span>${t('chart.replay.pickHint')}</span>
        <button data-rp="random" class="tb-btn">${t('chart.replay.random')}</button>
        <input class="rp-date" type="datetime-local" aria-label="${t('chart.replay.startDate')}">
        <button data-rp="date" class="tb-btn">${t('chart.replay.go')}</button>
        <button data-rp="cancel" class="tb-btn">${t('common.cancel')}</button>
      </div>
      <div class="replay-bar" hidden>
        <button data-rp="pick" title="${t('chart.replay.pickAgain')}" aria-label="${t('chart.replay.pickAgain')}">${ICON_CUT}</button>
        <button data-rp="play" title="${t('chart.replay.playTitle')}" aria-label="${t('chart.replay.playAria')}">${ICON_PLAY}</button>
        <button data-rp="step" title="${t('chart.replay.stepTitle')}" aria-label="${t('chart.replay.stepAria')}">${ICON_STEP}</button>
        <select data-rp="speed" title="${t('chart.replay.speedTitle')}" aria-label="${t('chart.replay.speedAria')}">${REPLAY_SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <span class="rp-time"></span>
        <button data-rp="exit" class="rp-exit" title="${t('chart.replay.exitTitle')}">${t('chart.replay.exit')}</button>
      </div>
      <div class="cell-tools">
        <button data-cell="max" title="${t('chart.maxTitle')}" aria-label="${t('chart.maxAria')}">${ICON_MAX}</button>
        <button data-cell="pop" title="${t('chart.popout')}" aria-label="${t('chart.popout')}">${ICON_POP}</button>
      </div>
      <button class="to-latest" hidden title="${t('chart.toLatest')}" aria-label="${t('chart.toLatest')}">${ICON_TO_LATEST}</button>
      <div class="overlay loading" hidden><div class="spinner"></div></div>
      <div class="overlay error" hidden></div>`;
    host.append(this.el);
    this.chartEl = this.el.querySelector('.chart-host');

    this.chart = LWC.createChart(this.chartEl, {
      ...chartOptions(currentTheme),
      autoSize: true,
      // Month names and the crosshair's date in the UI language ('23 Nov '26'; 2026-11-23 in zh/ja).
      localization: { locale, ...(lang === 'en' ? {} : { dateFormat: 'yyyy-MM-dd' }) },
      rightPriceScale: { borderColor: THEMES[currentTheme].border, scaleMargins: { top: 0.1, bottom: 0.12 } },
      timeScale: { borderColor: THEMES[currentTheme].border, rightOffset: 10, barSpacing: 8, timeVisible: true, secondsVisible: false },
    });
    this.main = null;
    this.bars = [];
    this.ha = [];
    this.meta = { precision: 2, name: '', exchange: '', symbol: '', tzOffset: 0 };
    this.feed = null;
    this.loadGen = 0;
    this.loadingOlder = false;
    this.lastCrosshair = null;
    this.live = new Map();      // indicator id -> entry
    this.compareEntries = new Map();
    this.alertList = [];
    this.alertLines = []; this.extLine = null;
    this.constCache = new Map();
    this.rebuilding = false;
    this.status = 'connecting';
    this.seriesLen = 0;
    this.dirtyFrom = Infinity;
    this.flushTimer = null;
    this.lastFlush = 0;
    this.lastTickAt = 0;
    this.destroyed = false;
    this.replay = null;          // { all, idx, clock, playing, speed, timer } while replaying
    this.replayPick = false;     // choosing the replay's first candle
    this.paperLines = new Map(); // id -> { spec, line } (paper-trading positions, stops, orders)
    this.paperFills = [];
    this.paperMarkers = null;
    this.drag = null;

    this.drawings = new DrawingLayer({
      formatPrice: (v) => this.formatPrice(v),
      onToolChange: (t) => this.hooks.onToolChange?.(this, t),
      onSelect: (d) => this.showDrawBar(d),
      theme: { bg: THEMES[currentTheme].bg, text: THEMES[currentTheme].strong },
    });
    this.countdown = new Countdown(this, { up: CANDLES.up, down: CANDLES.down });

    VIEWS.add(this);
    this.bindEvents();
    this.rebuildSeries();
    for (const c of this.state.compares) this.startCompare(c);
  }

  // --- small helpers ---------------------------------------------------------
  q(sel) { return this.el.querySelector(sel); }
  get tf() { return tfById(this.state.tf); }
  get ticker() { return displayTicker(this.state.symbol); }
  get source() { return parseSymbol(this.state.symbol).source; }
  get isCrypto() { return isCryptoSymbol(this.state.symbol); }
  get lastBar() { return this.bars[this.bars.length - 1]; }
  mainValueAt(i) { return this.state.chartType === 'heikin' && this.ha[i] ? this.ha[i].close : this.bars[i]?.close; }

  priceFormat() {
    return priceFormatOf(this.meta.precision ?? 2);
  }

  formatPrice(v) { return formatNumber(v, this.meta.precision ?? 2); }

  indicatorFormat(def) {
    if (def.format === 'volume') return { type: 'custom', formatter: formatVolume, minMove: 1 };
    if (def.precision != null) return priceFormatOf(def.precision);
    return this.priceFormat();
  }

  formatIndicator(def, v) {
    if (!Number.isFinite(v)) return '—';
    if (def.format === 'volume') return formatVolume(v);
    if (def.precision != null) return formatNumber(v, def.precision);
    const p = this.meta.precision ?? 2;
    return formatNumber(v, Math.abs(v) < 1 && p < 4 ? 4 : p);
  }

  constArray(value, n) {
    const key = `${value}|${n}`;
    let a = this.constCache.get(key);
    if (!a) { a = new Array(n).fill(value); if (this.constCache.size > 50) this.constCache.clear(); this.constCache.set(key, a); }
    return a;
  }

  indexOfTime(t) {
    const b = this.bars;
    let lo = 0, hi = b.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time === t) return mid;
      if (b[mid].time < t) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  indexAtOrBefore(t) {
    const b = this.bars;
    let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Converts a chart time to real UTC seconds (charts show exchange or local time). */
  utcAt(time) { return time - (this.meta.tzOffset || 0); }

  /** (x, y) of a mouse event relative to the price pane, or null when outside its plot area. */
  paneCoords(e, allowOutside = false) {
    const pane = this.chart.panes()[0];
    const paneEl = pane?.getHTMLElement();
    if (!paneEl) return null;
    const x = e.clientX - this.chartEl.getBoundingClientRect().left;
    const y = e.clientY - paneEl.getBoundingClientRect().top;
    if (!allowOutside && !(x >= 0 && x <= this.chart.timeScale().width() && y >= 0 && y <= pane.getHeight())) return null;
    return { x, y };
  }

  // --- events ----------------------------------------------------------------
  bindEvents() {
    this.el.addEventListener('pointerdown', () => this.hooks.onActivate?.(this), true);

    // Clicks and drags for drawings are read from the DOM: the chart library drops a second click
    // within ~500 ms of the first, and dragging a drawing must not pan the chart.
    let down = null;
    this.chartEl.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      if (e.button !== 0) return;
      const p = this.paneCoords(e);
      if (!p || this.replayPick) return;
      if (this.beginPaperDrag(p, e)) return;
      if (!this.drawings.beginDrag(p.x, p.y)) return;
      this.chart.applyOptions({ handleScroll: false, handleScale: false });
      const move = (ev) => { const q = this.paneCoords(ev, true); if (q) this.drawings.dragMove(q.x, q.y, ev.shiftKey); };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.drawings.endDrag();
        this.chart.applyOptions({ handleScroll: true, handleScale: true });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }, true);
    this.chartEl.addEventListener('dblclick', (e) => {
      const p = this.paneCoords(e);
      if (!p || this.replayPick || this.drawings.tool !== 'cursor') return;
      const id = this.drawings.hitTest(p.x, p.y);
      if (!id) return;
      e.preventDefault();
      this.drawings.select(id);
      this.openPointEditorFor(this.drawings.selected, { x: e.clientX, y: e.clientY });
    });
    this.chartEl.addEventListener('click', (e) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return; // a drag
      if (this.dragged) { this.dragged = false; return; }
      if (this.replayPick) { this.pickReplayAt(this.paneCoords(e)); return; }
      this.drawings.handleClick({ point: this.paneCoords(e), shift: e.shiftKey });
    }, true);

    this.chart.subscribeCrosshairMove((param) => {
      if (this.rebuilding) return;
      const real = !!param.sourceEvent; // false when another chart moved our crosshair
      if (real) this.drawings.handleMove(param);
      if (this.replayPick) this.movePick(param);
      else if (real && !this.drag) this.chartEl.style.cursor = param.point && this.paperHit(param.point.y) ? 'ns-resize' : '';
      this.updateLegend(param);
      this.positionPaneLegends();
      if (real || !param.point) this.hooks.onCrosshair?.(this, param);
    });

    const toLatest = this.q('.to-latest');
    toLatest.addEventListener('click', () => { this.chart.timeScale().scrollToRealTime(); toLatest.hidden = true; });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      this.updateToLatest(range);
      if (!range || this.loadingOlder || !this.feed?.canLoadMore || !this.bars.length) return;
      if (range.from < 40) this.loadOlder();
    });

    const rpBar = this.q('.replay-bar');
    const banner = this.q('.rp-banner');
    const onReplayClick = (e) => {
      const act = e.target.closest('[data-rp]')?.dataset.rp;
      if (act === 'play') this.toggleReplayPlay();
      if (act === 'step') { this.pauseReplay(); this.replayStep(); }
      if (act === 'pick') this.startReplayPick();
      if (act === 'exit') this.stopReplay();
      if (act === 'cancel') this.cancelReplayPick();
      if (act === 'random') this.replayRandom();
      if (act === 'date') this.replayToDate(this.q('.rp-date').value);
    };
    rpBar.addEventListener('click', onReplayClick);
    banner.addEventListener('click', onReplayClick);
    rpBar.querySelector('[data-rp="speed"]').addEventListener('change', (e) => this.setReplaySpeed(Number(e.target.value)));
    for (const el of [rpBar, banner, this.q('.qt')]) el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    this.q('.qt').addEventListener('click', (e) => {
      const side = e.target.closest('[data-qt]')?.dataset.qt;
      if (side) this.hooks.onQuickTrade?.(this, side, Number(this.q('.qt-qty').value));
    });
    this.q('.qt-qty').addEventListener('change', (e) => this.hooks.onQuickQty?.(this, Number(e.target.value)));

    this.resizeObserver = new ResizeObserver(() => this.positionPaneLegends());
    this.resizeObserver.observe(this.chartEl);
    this.chartEl.addEventListener('mouseup', () => requestAnimationFrame(() => this.positionPaneLegends()));

    const onLegendClick = (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.lg-row');
      if (btn.dataset.act === 'rm-cmp') { this.removeCompare(row.dataset.cmp); return; }
      const id = row.dataset.id;
      if (btn.dataset.act === 'eye') this.setIndicatorHidden(id, !isHidden(this.live.get(id)?.inst));
      else if (btn.dataset.act === 'remove') this.removeIndicator(id);
      else if (btn.dataset.act === 'code') this.hooks.onEditScript?.(this, this.live.get(id)?.inst.scriptId);
      else this.openSettings(id, btn);
    };
    this.q('.legend').addEventListener('click', onLegendClick);
    this.q('.pane-legends').addEventListener('click', onLegendClick);

    this.q('.cell-tools').addEventListener('click', (e) => {
      const act = e.target.closest('[data-cell]')?.dataset.cell;
      if (act === 'max') this.hooks.onMaximize?.(this);
      if (act === 'pop') this.hooks.onPopout?.(this);
    });

    const bar = this.q('.draw-bar');
    bar.addEventListener('click', (e) => {
      const color = e.target.closest('[data-color]')?.dataset.color;
      if (color) { this.drawings.updateSelected({ color }); return; }
      const style = e.target.closest('[data-stroke]')?.dataset.stroke;
      if (style) { this.drawings.updateSelected({ style }); return; }
      const act = e.target.closest('[data-db]')?.dataset.db;
      if (act === 'delete') this.drawings.deleteSelected();
      if (act === 'labels') {
        const d = this.drawings.selected;
        if (d) this.drawings.updateSelected({ labels: d.labels === false ? undefined : false });
      }
      if (act === 'alert') {
        const d = this.drawings.selected;
        if (d) this.hooks.onCreateAlert?.(this, d.p1.price);
      }
      if (act === 'fib') this.toggleFibPanel(e.target.closest('[data-db="fib"]'));
      if (act === 'edit') this.togglePointEditor(e.target.closest('[data-db="edit"]'));
    });
    bar.querySelector('.db-text').addEventListener('input', (e) => this.drawings.updateSelected({ text: e.target.value }));
    bar.querySelector('.db-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    bar.querySelector('.db-size input').addEventListener('input', (e) => {
      this.drawings.updateSelected({ size: Number(e.target.value) });
    });
    bar.querySelector('.db-width input').addEventListener('input', (e) => {
      if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) this.drawings.updateSelected({ width: clampWidth(e.target.value) });
    });
    bar.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /** The gear on a selected Fib: its levels and options (fib-panel.js). The Fib keeps them in `d.fib`. */
  toggleFibPanel(anchor) {
    const d = this.drawings.selected;
    if (!d || d.type !== 'fib') return;
    if (fibPanelId() === d.id) { closeFibPanel(); return; }
    closeSettings();
    openFibPanel(anchor, d, {
      onChange: (fib) => this.drawings.updateSelected({ fib }),
      onReset: () => this.drawings.updateSelected({ fib: undefined, labels: undefined }),
    });
  }

  /** Exact prices, dates and a label for the selected drawing (issue #6; point-editor.js). */
  openPointEditorFor(d, anchor) {
    if (!d || !editablePoints(d).length) return;
    closeFibPanel();
    closeSettings();
    openPointEditor(anchor, d, {
      title: TOOLS[d.type]?.label || '',
      daily: this.tf.daily,
      precision: this.meta?.precision ?? 2,
      decimalComma: (1.5).toLocaleString(locale).includes(','),
      onChange: (patch) => this.drawings.updateSelected(patch),
    });
  }

  togglePointEditor(anchor) {
    const d = this.drawings.selected;
    if (!d) return;
    if (pointEditorId() === d.id) { closePointEditor(); return; }
    this.openPointEditorFor(d, anchor);
  }

  showDrawBar(d) {
    const bar = this.q('.draw-bar');
    bar.hidden = !d;
    if (!d || fibPanelId() !== d.id) closeFibPanel(); // the panel belongs to the Fib that was selected
    if (!d || pointEditorId() !== d.id) closePointEditor();
    else refreshPointEditor(d); // dragged or edited: show the new values
    if (!d) return;
    bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === d.color));
    const text = bar.querySelector('.db-text');
    const symbol = isSymbol(d.type);
    text.hidden = d.type !== 'text' && !symbol;
    if ((d.type === 'text' || symbol) && document.activeElement !== text) text.value = d.text || '';
    const size = bar.querySelector('.db-size');
    size.hidden = !symbol;
    if (symbol) {
      const range = size.querySelector('input');
      if (document.activeElement !== range) range.value = d.size ?? SYMBOL_SIZE.default;
      size.querySelector('output').textContent = `${d.size ?? SYMBOL_SIZE.default}px`;
    }
    if (symbol && this.drawings.focusText) { // just placed: type its label straight away
      this.drawings.focusText = false;
      requestAnimationFrame(() => { text.focus(); });
    }
    const stroke = bar.querySelector('.db-stroke');
    stroke.hidden = !STROKE_TOOLS.has(d.type);
    if (!stroke.hidden) {
      const { style, width } = strokeOf(d);
      stroke.querySelectorAll('[data-stroke]').forEach((b) => b.classList.toggle('on', b.dataset.stroke === style));
      const input = stroke.querySelector('input');
      if (document.activeElement !== input) input.value = width;
    }
    bar.querySelector('[data-db="alert"]').hidden = !(d.type === 'hline' || d.type === 'hray');
    bar.querySelector('.db-colors').hidden = ['fib', 'long', 'short', 'measure'].includes(d.type);
    const labels = bar.querySelector('[data-db="labels"]');
    labels.hidden = !['long', 'short', 'avwap'].includes(d.type); // a Fib's labels are in its settings
    bar.querySelector('[data-db="fib"]').hidden = d.type !== 'fib';
    bar.querySelector('[data-db="edit"]').hidden = !editablePoints(d).length;
    const shown = d.labels !== false;
    labels.classList.toggle('on', shown);
    labels.title = t(shown ? 'chart.labelsHide' : 'chart.labelsShow');
    labels.setAttribute('aria-pressed', String(shown));
  }

  // --- main series -------------------------------------------------------------
  mainPoint(i) {
    const b = this.bars[i];
    switch (this.state.chartType) {
      case 'line': case 'area': case 'linemarkers': case 'stepline': case 'baseline':
        return { time: b.time, value: b.close };
      case 'columns': {
        const prev = this.bars[i - 1];
        const up = prev ? b.close >= prev.close : b.close >= b.open;
        return { time: b.time, value: b.close, color: alpha(up ? CANDLES.up : CANDLES.down, 0.65) };
      }
      case 'heikin': return this.ha[i];
      default: return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
    }
  }

  createMainSeries() {
    const common = { priceFormat: this.priceFormat(), autoscaleInfoProvider: this.autoscaleWithExt };
    const { up, down, wickUp, wickDown, line: lineColor } = CANDLES;
    const candle = { upColor: up, downColor: down, borderVisible: false, wickUpColor: wickUp, wickDownColor: wickDown };
    const line = { ...common, color: lineColor, lineWidth: 2 };
    const c = this.chart;
    switch (this.state.chartType) {
      case 'bars': this.main = c.addSeries(LWC.BarSeries, { ...common, upColor: up, downColor: down }, 0); break;
      case 'line': this.main = c.addSeries(LWC.LineSeries, line, 0); break;
      case 'linemarkers': this.main = c.addSeries(LWC.LineSeries, { ...line, pointMarkersVisible: true, pointMarkersRadius: 2.5 }, 0); break;
      case 'stepline': this.main = c.addSeries(LWC.LineSeries, { ...line, lineType: LWC.LineType.WithSteps }, 0); break;
      case 'area':
        this.main = c.addSeries(LWC.AreaSeries, {
          ...common, lineColor, lineWidth: 2, topColor: alpha(lineColor, 0.28), bottomColor: alpha(lineColor, 0.02),
        }, 0); break;
      case 'baseline':
        this.main = c.addSeries(LWC.BaselineSeries, {
          ...common, lineWidth: 2,
          baseValue: { type: 'price', price: this.baselinePrice() },
          topLineColor: up, topFillColor1: alpha(up, 0.28), topFillColor2: alpha(up, 0.04),
          bottomLineColor: down, bottomFillColor1: alpha(down, 0.04), bottomFillColor2: alpha(down, 0.28),
        }, 0); break;
      case 'columns': this.main = c.addSeries(LWC.HistogramSeries, { ...common, base: this.columnsBase() }, 0); break;
      case 'hollow':
        this.main = c.addSeries(LWC.CandlestickSeries, {
          ...common, ...candle, upColor: 'rgba(0,0,0,0)', borderVisible: true, borderUpColor: up, borderDownColor: down,
        }, 0); break;
      default: this.main = c.addSeries(LWC.CandlestickSeries, { ...common, ...candle }, 0);
    }
    this.main.attachPrimitive(this.drawings);
    this.main.attachPrimitive(this.countdown);
    c.panes()[0]?.setPreserveEmptyPane(true);
    this.applyScaleMode();
    this.applyAlertLines();
    this.applyExtLine();
    for (const x of this.paperLines.values()) x.line = null;
    this.applyPaperLines();
    this.paperMarkers = null;
    this.applyPaperMarkers();
  }

  baselinePrice() {
    const b = this.bars;
    return b.length ? b[Math.max(0, b.length - 150)].close : 0;
  }

  columnsBase() {
    let min = Infinity;
    for (let i = Math.max(0, this.bars.length - 500); i < this.bars.length; i++) min = Math.min(min, this.bars[i].low);
    return Number.isFinite(min) ? min * 0.98 : 0;
  }

  applyScaleMode() {
    const mode = this.compareEntries.size
      ? LWC.PriceScaleMode.Percentage
      : this.state.logScale ? LWC.PriceScaleMode.Logarithmic : LWC.PriceScaleMode.Normal;
    this.main?.priceScale().applyOptions({ mode });
  }

  applyTheme() {
    const t = THEMES[currentTheme];
    this.chart.applyOptions({ ...chartOptions(currentTheme), rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border } });
    this.drawings.setTheme({ bg: t.bg, text: t.strong });
  }

  /** New theme colors: chart chrome always; series only when candle/line colors changed. */
  restyle(seriesChanged) {
    this.applyTheme();
    this.countdown.colors = { up: CANDLES.up, down: CANDLES.down };
    if (seriesChanged) this.rebuildSeries();
  }

  // --- indicators: shared series creation -------------------------------------------
  seriesPoint(entry, plot, i, time = this.bars[i]?.time) {
    const v = entry.out[plot.key]?.[i];
    if (!Number.isFinite(v)) return { time };
    const p = { time, value: v };
    if (plot.colorFn) p.color = plot.colorFn(i, entry.out, this.bars, plot.key);
    else if (plot.colorsArr?.[i]) p.color = plot.colorsArr[i];
    return p;
  }

  createEntrySeries(entry) {
    const { def, inst } = entry;
    const c = this.chart;
    const paneIndex = def.overlay ? 0 : c.panes().length;
    entry.series = [];
    for (const plot of def.plots) {
      const opts = {
        color: plotColor(inst, plot),
        priceLineVisible: false,
        lastValueVisible: !def.scale && !def.hideLastValue && plot.type !== 'dots',
        priceFormat: this.indicatorFormat(def),
      };
      if (def.scale) opts.priceScaleId = def.scale;
      let api;
      if (plot.type === 'histogram') {
        api = c.addSeries(LWC.HistogramSeries, opts, paneIndex);
      } else {
        const lineOpts = { ...opts, lineWidth: plot.width ?? 2, crosshairMarkerRadius: 3 };
        if (plot.type === 'dots') Object.assign(lineOpts, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2, crosshairMarkerVisible: false });
        if (plot.type === 'step') lineOpts.lineType = LWC.LineType.WithSteps;
        api = c.addSeries(LWC.LineSeries, lineOpts, paneIndex);
      }
      entry.series.push({ plot, api });
    }
    const first = entry.series[0]?.api;
    if (!first) return;
    if (def.scale === 'volume') c.priceScale('volume', 0).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    entry.levelLines = (def.levels || []).map((level, k) => first.createPriceLine({
      price: level, color: def.levelColors?.[k] || THEMES[currentTheme].level,
      lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false,
    }));
    if (!def.overlay) first.getPane().setStretchFactor(0.3);
    entry.fillPrims = (def.fills || []).map((f) => {
      const prim = new BandFill(() => this.fillArrays(entry, f), f);
      first.attachPrimitive(prim);
      return { prim, target: first };
    });
    if (isHidden(inst)) applyEntryVisibility(entry); // hidden with the eye button: stays hidden when rebuilt
  }

  fillArrays(entry, f) {
    if (!entry.out) return null;
    const n = entry.outLen ?? this.bars.length;
    const arr = (k) => entry.out[k] ?? (f.consts && k in f.consts ? this.constArray(f.consts[k], n) : null);
    const a = arr(f.from), b = arr(f.to);
    return a && b ? { a, b } : null;
  }

  removeEntrySeries(entry) {
    const was = this.rebuilding;
    this.rebuilding = true;
    try {
      for (const { prim, target } of entry.fillPrims || []) { try { target.detachPrimitive(prim); } catch { /* gone */ } }
      entry.fillPrims = [];
      entry.levelLines = [];
      try { entry.markersApi?.detach(); } catch { /* gone */ }
      entry.markersApi = null;
      try { entry.tradeMarkers?.detach(); } catch { /* gone */ }
      if (entry.tradeLines && entry.tradeTarget) { try { entry.tradeTarget.detachPrimitive(entry.tradeLines); } catch { /* gone */ } }
      entry.tradeMarkers = null;
      entry.tradeLines = null;
      entry.tradeTarget = null;
      for (const { api } of entry.series || []) { try { this.chart.removeSeries(api); } catch { /* gone */ } }
      entry.series = [];
    } finally {
      this.rebuilding = was;
    }
  }

  // --- built-in indicators ---------------------------------------------------------
  addBuiltinEntry(inst) {
    const def = INDICATORS[inst.type];
    inst.params = coerceParams(inst.params, def.params); // defaults for missing ones, each as its declared type
    const entry = { inst, def, series: [], out: null };
    this.createEntrySeries(entry);
    this.live.set(inst.id, entry);
    if (this.bars.length) this.computeAndSet(entry);
    return entry;
  }

  computeAndSet(entry) {
    if (entry.script) { entry.halted = false; this.runScript(entry, true); return; }
    entry.out = entry.def.calc(this.bars, entry.inst.params, { tfSec: this.tf.sec });
    entry.outLen = this.bars.length;
    for (const { plot, api } of entry.series) {
      api.setData(this.bars.map((_, i) => this.seriesPoint(entry, plot, i)));
    }
  }

  // --- script indicators ---------------------------------------------------------------
  addScriptEntry(inst) {
    inst.params ||= {};
    const entry = { inst, script: true, def: null, series: [], out: null, sig: null, error: null, running: false, again: false, lastRun: 0, timer: null };
    this.live.set(inst.id, entry);
    this.runScript(entry, true);
    return entry;
  }

  hasScript(scriptId) {
    return [...this.live.values()].some((e) => e.script && e.inst.scriptId === scriptId);
  }

  addScript(scriptId) {
    const inst = { id: uid(), type: 'script', scriptId, params: {} };
    this.state.indicators.push(inst);
    this.addScriptEntry(inst);
    this.buildLegend();
    this.hooks.onChange?.(this);
  }

  /** Runs a script indicator in the worker; repeated calls while it runs are coalesced. */
  runScript(entry, now = false) {
    if (!this.bars.length || this.destroyed) return;
    if (entry.halted && !now) return; // it timed out; wait for an edit instead of retrying on every tick
    if (entry.running) { entry.again = true; return; }
    const wait = now ? 0 : Math.max(0, SCRIPT_MIN_MS - (performance.now() - entry.lastRun));
    if (wait > 0) {
      if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = null; this.runScript(entry, true); }, wait);
      return;
    }
    const script = scriptStore.get(entry.inst.scriptId);
    // A community script installed earlier on the static website must not run there: without the
    // app's server, its worker has no CSP to cut it off from the internet (see community.js).
    const blocked = script?.community && !canRunCommunity();
    if (!script || blocked) {
      entry.error = blocked ? t('chart.err.communityDesktopOnly') : t('chart.err.scriptDeleted');
      this.removeEntrySeries(entry);
      entry.sig = null;
      this.buildLegend();
      return;
    }
    entry.running = true;
    entry.lastRun = performance.now();
    const times = this.bars.map((b) => b.time);
    engine().run(script.code, this.bars, entry.inst.params, { tfSec: this.tf.sec, symbol: this.state.symbol, strategy: entry.inst.strategy }, entry.inst.scriptId)
      .then((res) => {
        if (this.destroyed || this.live.get(entry.inst.id) !== entry) return;
        const hadError = !!entry.error;
        entry.error = null;
        entry.name = script.name;
        this.applyScriptResult(entry, res, times, hadError);
      })
      .catch((err) => {
        if (this.destroyed || this.live.get(entry.inst.id) !== entry) return;
        if (err.restarted) { entry.again = true; return; } // another script hung; just try again
        entry.halted = !!err.halted; // timed out (scripts.js); the message is in the UI language
        entry.error = err.line ? t('chart.err.scriptLine', { line: err.line, message: err.message }) : err.message;
        this.buildLegend();
      })
      .finally(() => {
        entry.running = false;
        if (entry.again && !this.destroyed) { entry.again = false; this.runScript(entry); }
      });
  }

  applyScriptResult(entry, res, times, forceLegend) {
    const def = scriptDef(res);
    // Settings as the script now declares them: defaults for new inputs (so settings show them), and a
    // value saved for an input of another type (text last run, a number now…) is replaced, never reused.
    const params = coerceParams(entry.inst.params, def.params);
    const old = entry.inst.params || {};
    const changedParams = Object.keys(old).length !== def.params.length || def.params.some((p) => !Object.is(old[p.key], params[p.key]));
    entry.inst.params = params;
    const sig = JSON.stringify([def.overlay, def.plots.map((p) => [p.key, p.type, p.width]), def.levels, def.fills.map((f) => [f.from, f.to])]);
    const structural = sig !== entry.sig;
    if (structural) {
      this.removeEntrySeries(entry);
      entry.def = def;
      entry.sig = sig;
      this.createEntrySeries(entry);
    } else {
      entry.def = def;
      entry.series.forEach((s, k) => { s.plot = def.plots[k]; });
    }
    entry.out = Object.fromEntries(res.plots.map((p) => [p.key, p.values]));
    entry.outLen = times.length;
    for (const { plot, api } of entry.series) {
      if (!structural && !entry.inst.colors?.[plot.key]) api.applyOptions({ color: plot.color });
      api.setData(times.map((t, i) => this.seriesPoint(entry, plot, i, t)));
    }
    // Markers go on the price series for overlays, else on the script's own first plot.
    const target = def.overlay ? this.main : entry.series[0]?.api;
    if (res.markers.length && target) {
      if (!entry.markersApi || entry.markersTarget !== target) {
        try { entry.markersApi?.detach(); } catch { /* gone */ }
        entry.markersApi = LWC.createSeriesMarkers(target, []);
        entry.markersTarget = target;
      }
      // In bar order (script-sanitize.js sorts them) and never past the bars this run had.
      entry.markerData = res.markers.filter((m) => times[m.i] != null)
        .map((m) => ({ time: times[m.i], position: m.position, shape: m.shape, color: m.color, text: m.text }));
    } else {
      entry.markerData = [];
    }
    syncMarkers(entry);
    if (res.strategy) this.applyStrategy(entry, res.strategy, times);
    if (structural || forceLegend) this.buildLegend();
    else this.updateLegend(this.lastCrosshair);
    if (changedParams) this.hooks.onChange?.(this);
    if (res.strategy) this.hooks.onStrategy?.(this, entry);
  }

  /** Trade markers and entry→exit lines on the price series for a backtest result. */
  applyStrategy(entry, report, times) {
    entry.report = report;
    entry.times = times;
    if (!this.main) return;
    if (!entry.tradeMarkers || entry.tradeTarget !== this.main) {
      try { entry.tradeMarkers?.detach(); } catch { /* gone */ }
      if (entry.tradeLines && entry.tradeTarget) { try { entry.tradeTarget.detachPrimitive(entry.tradeLines); } catch { /* gone */ } }
      entry.tradeMarkers = LWC.createSeriesMarkers(this.main, []);
      entry.tradeLines = new TradeLines(() => entry.tradeLineData);
      this.main.attachPrimitive(entry.tradeLines);
      entry.tradeTarget = this.main;
    }
    const SHORT = {
      'Take profit': 'TP', 'Stop loss': 'SL', Stop: t('chart.mk.stop'), 'Trailing stop': t('chart.mk.trail'),
      Reverse: t('chart.mk.reverse'), Close: t('chart.mk.close'),
    };
    const markers = report.markers.filter((m) => times[m.i] != null).map((m) => {
      const long = m.side === 'long';
      if (m.kind === 'entry') {
        return { time: times[m.i], position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#4FA3F7' : '#EC5246', text: m.id };
      }
      return { time: times[m.i], position: long ? 'aboveBar' : 'belowBar', shape: long ? 'arrowDown' : 'arrowUp', color: '#E040FB', text: (Object.hasOwn(SHORT, m.reason) && SHORT[m.reason]) || m.reason };
    });
    markers.sort((a, b) => a.time - b.time);
    entry.tradeMarkerData = markers;
    entry.tradeLines.setHidden(isHidden(entry.inst));
    syncMarkers(entry);
    entry.tradeLineData = {
      trades: report.trades.map((t) => ({ ei: t.entryIndex, ep: t.entryPrice, xi: t.exitIndex, xp: t.exitPrice, win: t.pnl > 0 })),
    };
  }

  /** Strategy entries on this chart (for the Strategy Tester). */
  strategies() { return [...this.live.values()].filter((e) => e.def?.strategy); }

  setStrategyProps(id, props) {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.inst.strategy = props;
    entry.halted = false;
    this.runScript(entry, true);
    this.hooks.onChange?.(this);
  }

  /** Scrolls the chart to show bars a..b (e.g. one backtest trade). */
  focusBars(a, b) {
    const pad = Math.max(10, Math.round((b - a) * 0.6));
    this.chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  }

  // --- rebuild everything ------------------------------------------------------------
  removeIndicatorSeries(entry) {
    this.live.delete(entry.inst.id);
    clearTimeout(entry.timer);
    this.removeEntrySeries(entry);
  }

  /** Recreate every series in z-order: volume behind price, other overlays on top. */
  rebuildSeries() {
    this.rebuilding = true;
    try {
      for (const entry of [...this.live.values()]) this.removeIndicatorSeries(entry);
      if (this.main) {
        this.main.detachPrimitive(this.drawings);
        this.main.detachPrimitive(this.countdown);
        this.alertLines = []; this.extLine = null;
        try { this.chart.removeSeries(this.main); } catch { /* gone */ }
        this.main = null;
      }
      for (const inst of this.state.indicators) if (inst.type === 'volume') this.addBuiltinEntry(inst);
      this.createMainSeries();
      for (const inst of this.state.indicators) {
        if (inst.type === 'volume') continue;
        if (inst.type === 'script') this.addScriptEntry(inst); else this.addBuiltinEntry(inst);
      }
      if (this.bars.length) this.renderAll(false);
    } finally {
      this.rebuilding = false;
    }
    this.buildLegend();
  }

  // --- public actions (called by the app shell) ----------------------------------------
  setSymbol(full) {
    if (full === this.state.symbol) return;
    this.state.symbol = full;
    this.load();
    this.hooks.onSymbol?.(this, full);
  }

  /** Any timeframe: '45m', '4h', or typed forms such as '45', '240', 'D' (see timeframes.js). */
  setTimeframe(tf) {
    const id = tfIdOf(tf);
    if (!id || id === this.state.tf) return;
    this.state.tf = id;
    this.load();
    this.hooks.onTimeframe?.(this, id);
  }

  setChartType(type) {
    this.state.chartType = type;
    this.rebuildSeries();
    this.hooks.onChange?.(this);
  }

  setLogScale(on) {
    this.state.logScale = on;
    this.applyScaleMode();
    this.hooks.onChange?.(this);
  }

  addIndicator(type) {
    const def = INDICATORS[type];
    const list = this.state.indicators;
    if (type === 'volume' && list.some((i) => i.type === 'volume')) return false;
    const inst = { id: uid(), type, params: defaultParams(type), colors: {} };
    for (const plot of def.plots) {
      if (plot.color !== 'auto') continue;
      const used = new Set(list.flatMap((i) => Object.values(i.colors || {})));
      inst.colors[plot.key] = PALETTE.find((c) => !used.has(c)) || PALETTE[list.length % PALETTE.length];
    }
    list.push(inst);
    if (type === 'volume') this.rebuildSeries();
    else { this.addBuiltinEntry(inst); this.buildLegend(); }
    this.hooks.onChange?.(this);
    return true;
  }

  /** The legend's eye button: hide or show an indicator on the chart without removing it. */
  setIndicatorHidden(id, hidden) {
    const entry = this.live.get(id);
    if (!entry) return;
    setHiddenFlag(entry.inst, hidden);
    applyEntryVisibility(entry);
    this.buildLegend();
    this.hooks.onChange?.(this);
  }

  removeIndicator(id) {
    const entry = this.live.get(id);
    if (!entry) return;
    this.removeIndicatorSeries(entry);
    this.state.indicators = this.state.indicators.filter((i) => i.id !== id);
    if (settings.view === this) closeSettings();
    this.buildLegend();
    this.hooks.onChange?.(this);
  }

  setTool(tool) { this.drawings.setTool(tool); }
  cancelDrawing() { return this.drawings.cancel(); }
  deleteSelectedDrawing() { return this.drawings.deleteSelected(); }
  clearDrawings() { this.drawings.clearAll(); }

  setActive(on) { this.el.classList.toggle('active', on); }

  /** Shows a crosshair at the given UTC time (from another chart), or hides it. */
  showCrosshairAt(utc) {
    if (utc == null || !this.bars.length || !this.main) {
      this.chart.clearCrosshairPosition();
      this.updateLegend(null);
      return;
    }
    const i = this.indexAtOrBefore(utc + (this.meta.tzOffset || 0));
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const offScreen = range && (i < Math.floor(range.from) || i > Math.ceil(range.to));
    if (i < 0 || offScreen) { this.chart.clearCrosshairPosition(); this.updateLegend(null); return; }
    const p = this.mainPoint(i);
    this.chart.setCrosshairPosition(p.close ?? p.value, p.time, this.main);
    this.updateLegend({ time: p.time });
  }

  /** Price-alert lines for this chart's symbol. */
  setAlerts(list) {
    this.alertList = list;
    this.applyAlertLines();
    this.applyExtLine();
  }

  applyAlertLines() {
    if (!this.main) return;
    for (const l of this.alertLines) { try { this.main.removePriceLine(l); } catch { /* gone */ } }
    this.alertLines = this.alertList
      .filter((a) => a.active && a.symbol === this.state.symbol)
      .map((a) => this.main.createPriceLine({
        price: a.price, color: '#FF9800', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: t('chart.alertLine'),
      }));
  }

  /** Latest pre-market / after-hours / overnight trade of a stock, or null during the regular session. */
  setExtended(x) {
    if (!x && !this.ext) return;
    const label = !x ? '' : x.session === 0 ? 'Pre' : x.session === 2 ? 'Post' : 'Overnight';
    if (x && this.ext?.price === x.price && this.ext.label === label) return;
    this.ext = x ? { ...x, label } : null;
    this.applyExtLine();
    this.updateLegend(this.lastCrosshair);
  }

  applyExtLine() {
    if (!this.main) return;
    const opts = this.ext && {
      price: this.ext.price, color: CANDLES.accent, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true, title: t(`chart.ext.${this.ext.label.toLowerCase()}Short`),
    };
    if (this.extLine && opts) this.extLine.applyOptions(opts);
    else {
      if (this.extLine) { try { this.main.removePriceLine(this.extLine); } catch { /* gone */ } this.extLine = null; }
      if (opts) this.extLine = this.main.createPriceLine(opts);
    }
    // Re-run autoscale so the line is never off-screen (see autoscaleWithExt).
    this.main.applyOptions({ autoscaleInfoProvider: this.autoscaleWithExt });
  }

  /** Autoscale that also fits the extended-hours price, so its line can't sit off-screen. */
  autoscaleWithExt = (original) => {
    const res = original();
    const p = this.ext?.price;
    if (!res?.priceRange || !Number.isFinite(p)) return res;
    // Only while the latest bar is on screen; scrolled into history it would squash the candles.
    const r = this.chart.timeScale().getVisibleLogicalRange();
    if (!r || r.to < this.bars.length - 1) return res;
    return {
      ...res,
      priceRange: { minValue: Math.min(res.priceRange.minValue, p), maxValue: Math.max(res.priceRange.maxValue, p) },
    };
  };

  screenshot() {
    const canvas = this.chart.takeScreenshot(true);
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / this.chartEl.clientWidth;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.font = '600 14px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = THEMES[currentTheme].strong;
    ctx.fillText(`${this.ticker} · ${this.tf.label} · ${this.meta.exchange || ''}`, 12, 22);
    ctx.restore();
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${this.ticker.replace(/[^\w.-]/g, '')}_${this.state.tf}_${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.replay?.timer);
    VIEWS.delete(this);
    this.loadGen++;
    this.feed?.close();
    this.feed = null;
    for (const e of this.compareEntries.values()) e.feed?.close();
    for (const e of this.live.values()) clearTimeout(e.timer);
    clearTimeout(this.flushTimer);
    this.resizeObserver.disconnect();
    if (settings.view === this) closeSettings();
    // A live chart usually has a redraw queued for the next frame, and disposing it under that
    // redraw throws "Object is disposed" (seen when going from 8 charts to 1). Detach it now and
    // dispose it two frames later, after any queued redraw has run.
    this.el.remove();
    const chart = this.chart;
    requestAnimationFrame(() => requestAnimationFrame(() => { try { chart.remove(); } catch { /* already gone */ } }));
  }

  // --- compare symbols -----------------------------------------------------------------
  addCompare(full) {
    if (full === this.state.symbol || this.state.compares.some((c) => c.symbol === full)) return false;
    const used = new Set(this.state.compares.map((c) => c.color));
    const c = { symbol: full, color: COMPARE_COLORS.find((x) => !used.has(x)) || COMPARE_COLORS[0] };
    this.state.compares.push(c);
    this.startCompare(c);
    this.applyScaleMode();
    this.buildLegend();
    this.hooks.onChange?.(this);
    return true;
  }

  removeCompare(full) {
    const e = this.compareEntries.get(full);
    if (e) this.stopCompare(e);
    this.state.compares = this.state.compares.filter((c) => c.symbol !== full);
    this.applyScaleMode();
    this.buildLegend();
    this.hooks.onChange?.(this);
  }

  startCompare(c) {
    const entry = { c, feed: null, bars: [], tz: 0, lastPrice: null, error: null };
    entry.series = this.chart.addSeries(LWC.LineSeries, {
      color: c.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3,
    }, 0);
    this.compareEntries.set(c.symbol, entry);
    this.loadCompare(entry);
  }

  loadCompare(entry) {
    entry.feed?.close();
    const feed = createFeed(entry.c.symbol, this.tf);
    entry.feed = feed;
    entry.lastPrice = null;
    feed.loadInitial().then((res) => {
      if (entry.feed !== feed) return;
      entry.bars = res.bars;
      entry.tz = res.meta?.tzOffset || 0;
      entry.error = null;
      this.renderCompare(entry);
      feed.subscribe({
        bars: (b) => {
          for (const nb of b) {
            const last = entry.bars[entry.bars.length - 1];
            if (!last || nb.time > last.time) entry.bars.push(nb);
            else if (nb.time === last.time) entry.bars[entry.bars.length - 1] = nb;
          }
          this.markDirty(this.bars.length - 1);
        },
        tick: (t) => { entry.lastPrice = t.price; this.markDirty(this.bars.length - 1); },
        status: () => {},
      });
    }).catch((err) => {
      if (entry.feed !== feed) return;
      entry.error = err.message;
      this.buildLegend();
    });
  }

  stopCompare(entry) {
    entry.feed?.close();
    entry.feed = null;
    try { this.chart.removeSeries(entry.series); } catch { /* gone */ }
    this.compareEntries.delete(entry.c.symbol);
  }

  /** Aligns the compare symbol to this chart's bars (its last close at or before each bar). */
  renderCompare(entry) {
    const n = this.bars.length;
    if (!entry.bars.length || !n) { entry.series.setData([]); return; }
    const off = (this.meta.tzOffset || 0) - entry.tz;
    const cb = entry.bars;
    const data = new Array(n);
    let j = -1;
    for (let i = 0; i < n; i++) {
      const t = this.bars[i].time - off;
      while (j + 1 < cb.length && cb[j + 1].time <= t) j++;
      data[i] = j >= 0 ? { time: this.bars[i].time, value: cb[j].close } : { time: this.bars[i].time };
    }
    if (entry.lastPrice != null && j === cb.length - 1) data[n - 1] = { time: this.bars[n - 1].time, value: entry.lastPrice };
    entry.series.setData(data);
    entry.value = data[n - 1]?.value;
  }

  // --- loading -----------------------------------------------------------------
  setStatus(s) {
    if (s !== 'replay') this.feedStatus = s;
    this.status = this.replay ? 'replay' : s === 'replay' ? this.feedStatus || 'connecting' : s;
    this.hooks.onStatus?.(this);
  }

  async load() {
    const gen = ++this.loadGen;
    this.pauseReplay();
    this.feed?.close();
    this.feed = null;
    if (settings.view === this) closeSettings();
    this.q('.overlay.loading').hidden = false;
    this.showError(null);
    this.setStatus('connecting');
    this.updateTitle();
    this.hooks.onChange?.(this);

    const tf = this.tf;
    const f = createFeed(this.state.symbol, tf);
    try {
      const res = await f.loadInitial();
      if (gen !== this.loadGen) { f.close(); return; }
      if (!res.bars?.length) throw new Error(t('chart.err.noData'));
      this.meta = { tzOffset: 0, ...res.meta };
      let bars = res.bars;
      if (this.replay) {
        // Replaying: fetch older candles until the replay's date is covered (a lower timeframe
        // starts with less history), then continue at that moment.
        const tz = this.meta.tzOffset || 0;
        for (let k = 0; k < 25 && f.canLoadMore && bars[0].time - tz + tf.sec > this.replay.clock; k++) {
          const older = await f.loadOlder(bars[0].time).catch(() => []);
          if (gen !== this.loadGen) { f.close(); return; }
          if (!older.length) break;
          bars = older.concat(bars);
        }
      }
      this.bars = bars;
      if (this.replay) this.resumeReplayOn(bars);
      this.feed = f;
      this.main.applyOptions({ priceFormat: this.priceFormat() });
      for (const entry of this.live.values()) {
        if (!entry.def) continue;
        for (const { api } of entry.series) api.applyOptions({ priceFormat: this.indicatorFormat(entry.def) });
      }
      if (this.state.chartType === 'baseline') this.main.applyOptions({ baseValue: { type: 'price', price: this.baselinePrice() } });
      if (this.state.chartType === 'columns') this.main.applyOptions({ base: this.columnsBase() });
      this.drawings.setContext(this.state.symbol, tf.sec);
      this.renderAll(true);
      this.updateTitle();
      this.applyAlertLines();
      this.setExtended(null); // a new symbol starts without an extended-hours price
      for (const e of this.compareEntries.values()) this.loadCompare(e);
      this.hooks.onChange?.(this);
      f.subscribe({
        bars: (b) => { if (this.feed === f) this.applyBars(b); },
        tick: (t) => { if (this.feed === f) this.applyTick(t); },
        status: (s) => { if (this.feed === f) this.setStatus(s); },
        extended: (x) => { if (this.feed === f) this.setExtended(x); },
      });
    } catch (e) {
      if (gen !== this.loadGen) return;
      f.close();
      if (this.replay) this.endReplay();
      this.bars = [];
      this.main.setData([]);
      for (const entry of this.live.values()) for (const { api } of entry.series) api.setData([]);
      this.seriesLen = 0;
      this.drawings.setContext(this.state.symbol, tf.sec);
      this.drawings.setBars(this.bars);
      this.setStatus('error');
      this.showError(e.message || String(e), e.code);
      this.updateTitle();
      this.hooks.onChange?.(this);
    } finally {
      if (gen === this.loadGen) this.q('.overlay.loading').hidden = true;
    }
  }

  async loadOlder() {
    this.loadingOlder = true;
    const f = this.feed, gen = this.loadGen;
    try {
      const older = await f.loadOlder(this.bars[0].time);
      if (gen !== this.loadGen || this.feed !== f || !older.length) return 0;
      this.bars = older.concat(this.bars);
      if (this.replay) {
        this.replay.all = older.concat(this.replay.all);
        this.replay.idx += older.length;
      }
      this.renderAll(false); // the chart keeps its scroll position when data is prepended
      return older.length;
    } catch (e) {
      console.warn('Could not load older bars:', e);
      return 0;
    } finally {
      this.loadingOlder = false;
    }
  }

  showError(msg, code) {
    const el = this.q('.overlay.error');
    el.hidden = !msg;
    if (!msg) return;
    const needsKey = code === 'NEEDS_KEY';
    const ticker = esc(this.ticker);
    el.innerHTML = `<div class="error-card"><b>${needsKey ? t('chart.err.needsKey', { ticker }) : t('chart.err.couldNotLoad', { ticker })}</b>
      <span>${esc(msg)}</span>
      <div class="error-actions">
        ${needsKey ? `<button class="btn-primary" data-err="key">${t('chart.err.connectKey')}</button>` : ''}
        <button class="${needsKey ? 'btn-ghost' : 'btn-primary'}" data-err="search">${needsKey ? t('chart.err.chartCrypto') : t('chart.err.searchAnother')}</button>
      </div></div>`;
    el.querySelector('[data-err="search"]').addEventListener('click', () => this.hooks.onSearch?.(this));
    el.querySelector('[data-err="key"]')?.addEventListener('click', () => this.hooks.onSettings?.(this));
  }

  // --- rendering & live updates ---------------------------------------------------
  renderAll(resetView) {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirtyFrom = Infinity;
    if (this.state.chartType === 'heikin') this.ha = heikinAshi(this.bars);
    this.main.setData(this.bars.map((_, i) => this.mainPoint(i)));
    for (const entry of this.live.values()) this.computeAndSet(entry);
    for (const e of this.compareEntries.values()) this.renderCompare(e);
    this.seriesLen = this.bars.length;
    this.drawings.setBars(this.bars);
    this.chart.applyOptions({ timeScale: { timeVisible: !this.tf.daily } });
    if (resetView && this.bars.length) this.resetView();
    this.updateLegend(this.lastCrosshair);
    this.applyPaperMarkers();
    this.updateQuickTrade();
    this.updateToLatest();
  }

  /**
   * Show the latest bars with every price scale back on auto. Called for each new symbol or
   * timeframe: dragging a price axis turns its auto-scaling off, and the next symbol (at a
   * different price) would otherwise open into empty space.
   */
  resetView() {
    const n = this.bars.length;
    const series = [this.main];
    for (const entry of this.live.values()) for (const { api } of entry.series) series.push(api);
    for (const e of this.compareEntries.values()) if (e.series) series.push(e.series);
    for (const s of series) {
      try { s.priceScale().applyOptions({ autoScale: true }); } catch { /* series without a scale */ }
    }
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-5, n - 150), to: n + 10 });
  }

  /** The "go to the latest candle" button: shown while the newest candle is off the right edge (issue #7). */
  updateToLatest(range = this.chart.timeScale().getVisibleLogicalRange()) {
    const btn = this.q('.to-latest');
    const off = !!range && this.bars.length > 0 && !this.replay && range.to < this.bars.length - 1.5;
    if (btn.hidden !== !off) btn.hidden = !off;
    if (!off) return;
    // Just inside the corner of the price pane: left of the price scale, above the time scale.
    btn.style.right = `${(this.chart.priceScale('right').width() || 60) + 10}px`;
    btn.style.bottom = `${(this.chart.timeScale().height() || 28) + 10}px`;
  }

  /** Start time of the bar that a tick at chart time t belongs to, given the last bar's start. */
  bucketFor(t, lastTime) {
    const tf = this.tf;
    // Crypto feeds know their bar grid (it restarts each day at 00:00 UTC, like the exchange's);
    // stock feeds start a new session's first bar at its open.
    const own = this.feed?.bucketOf?.(t, lastTime);
    if (own != null) return own;
    if (tf.id === '1D') return Math.floor(t / DAY) * DAY;
    if (tf.id === '1M') {
      const d = new Date(t * 1000), l = new Date(lastTime * 1000);
      if (d.getUTCFullYear() === l.getUTCFullYear() && d.getUTCMonth() === l.getUTCMonth()) return lastTime;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    }
    return lastTime + Math.floor((t - lastTime) / tf.sec) * tf.sec;
  }

  /** A single trade: moves the current bar (or starts the next one) right away. */
  applyTick({ time, price, volume = 0 }) {
    if (this.replay) return;
    const n = this.bars.length;
    if (!n || !Number.isFinite(price)) return;
    const last = this.bars[n - 1];
    // Some markets date the current bar ahead of the clock: futures trading from 18:00 New York
    // time belong to the next day's daily bar. A trade less than one bar before the last bar's
    // start still belongs to it; anything older is stale.
    if (time < last.time && last.time - time >= this.tf.sec) return;
    const bucket = time < last.time ? last.time : this.bucketFor(time, last.time);
    if (bucket === last.time) {
      this.bars[n - 1] = {
        ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price), volume: last.volume + volume,
      };
      this.markDirty(n - 1);
    } else if (bucket > last.time) {
      this.bars.push({ time: bucket, open: price, high: price, low: price, close: price, volume });
      this.markDirty(n);
    }
    this.lastTickAt = Date.now();
  }

  /** Official bars (from a poll or the exchange's bar stream). Reconciles with tick-built bars. */
  applyBars(newBars) {
    if (this.replay || !this.bars.length || !newBars?.length) return;
    const first = newBars[0].time;
    // New bars that start long after the history ends mean the history was an old copy (issue #7):
    // gluing them on would hide the missing weeks. Load the history again instead (once per
    // symbol and timeframe every 10 minutes, in case the source keeps sending the old copy).
    const gap = first - this.bars[this.bars.length - 1].time;
    if (gap > Math.max(10 * 86400, 50 * this.tf.sec)) {
      const key = `${this.state.symbol}|${this.tf.id}`;
      if (this.gapReload?.key !== key || Date.now() - this.gapReload.t > 600000) {
        this.gapReload = { key, t: Date.now() };
        this.load();
        return;
      }
    }
    const lastNew = newBars[newBars.length - 1].time;
    const times = new Set(newBars.map((b) => b.time));

    for (let i = this.bars.length - 1; i >= 0 && this.bars[i].time >= first; i--) {
      const t = this.bars[i].time;
      if (t <= lastNew && !times.has(t)) {
        // Bars built from ticks don't line up with the official ones: take the official tail.
        const ahead = this.bars.filter((b) => b.time > lastNew);
        this.bars = this.bars.filter((b) => b.time < first).concat(newBars.map((b) => ({ ...b })), ahead);
        this.renderAll(false);
        return;
      }
    }

    const fresh = Date.now() - this.lastTickAt < 15000;
    for (const nb of newBars) {
      const n = this.bars.length;
      const last = this.bars[n - 1];
      if (nb.time > last.time) { this.bars.push({ ...nb }); this.markDirty(n); continue; }
      const i = nb.time === last.time ? n - 1 : this.indexOfTime(nb.time);
      if (i < 0) continue;
      let b = nb;
      if (i === n - 1 && fresh) {
        const cur = this.bars[i]; // the streamed price is newer than a polled bar
        b = { ...nb, close: cur.close, high: Math.max(nb.high, cur.high), low: Math.min(nb.low, cur.low), volume: Math.max(nb.volume, cur.volume) };
      }
      if (!sameBar(this.bars[i], b)) { this.bars[i] = { ...b }; this.markDirty(i); }
    }
  }

  markDirty(i) {
    if (i < 0) return;
    this.dirtyFrom = Math.min(this.dirtyFrom, i);
    if (this.flushTimer) return;
    const wait = Math.max(0, FLUSH_MS - (performance.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
  }

  flush() {
    if (this.destroyed || this.dirtyFrom === Infinity || !this.main || !this.bars.length) return;
    const from = Math.min(this.dirtyFrom, this.bars.length - 1);
    this.dirtyFrom = Infinity;
    this.lastFlush = performance.now();
    const prevLen = this.seriesLen;
    const n = this.bars.length;
    try {
      if (this.state.chartType === 'heikin') for (let i = from; i < n; i++) this.ha[i] = heikinAshiAt(this.bars, this.ha, i);
      for (let i = from; i < n; i++) this.main.update(this.mainPoint(i), i < prevLen - 1);
      for (const entry of this.live.values()) {
        if (entry.script) { this.runScript(entry); continue; }
        entry.out = entry.def.calc(this.bars, entry.inst.params, { tfSec: this.tf.sec });
        entry.outLen = n;
        for (const { plot, api } of entry.series) {
          for (let i = from; i < n; i++) api.update(this.seriesPoint(entry, plot, i), i < prevLen - 1);
        }
      }
      for (const e of this.compareEntries.values()) this.renderCompare(e);
      this.seriesLen = n;
    } catch (e) {
      console.warn('Live update fell back to a full redraw:', e);
      this.renderAll(false);
    }
    this.drawings.setBars(this.bars);
    this.updateLegend(this.lastCrosshair);
    this.updateQuickTrade();
    this.hooks.onUpdate?.(this);
  }

  // --- bar replay ---------------------------------------------------------------
  /** UTC time at which the replay's current candle closes (the replay's "now"). */
  replayClock() { return this.utcAt(this.lastBar.time) + this.tf.sec; }

  /** Shows every loaded candle and lets the user click where the replay should start. */
  startReplayPick() {
    if (!this.bars.length || !this.feed) return false;
    this.pauseReplay();
    if (this.replay) { this.bars = this.replay.all.slice(); this.renderAll(false); }
    this.replayPick = true;
    this.q('.rp-banner').hidden = false;
    this.q('.rp-pick').hidden = false;
    this.q('.replay-bar').hidden = true;
    this.q('.rp-date').value = new Date(this.bars[Math.max(0, this.bars.length - 100)].time * 1000).toISOString().slice(0, 16);
    this.movePick(null);
    this.hooks.onReplay?.(this, 'pick');
    return true;
  }

  cancelReplayPick() {
    if (!this.replayPick) return false;
    this.replayPick = false;
    this.q('.rp-banner').hidden = true;
    this.q('.rp-pick').hidden = true;
    if (this.replay) {
      this.bars = this.replay.all.slice(0, this.replay.idx + 1);
      this.renderAll(false);
      this.q('.replay-bar').hidden = false;
    }
    this.hooks.onReplay?.(this, 'cancel');
    return true;
  }

  /** The dimmed "future" to the right of the candle under the mouse. */
  movePick(param) {
    const el = this.q('.rp-pick');
    const x = param?.logical != null ? this.chart.timeScale().logicalToCoordinate(Math.round(param.logical)) : null;
    el.style.setProperty('--x', x == null ? '-10px' : `${x}px`);
  }

  pickReplayAt(p) {
    if (!p) return;
    const l = this.chart.timeScale().coordinateToLogical(p.x);
    if (l == null) return;
    this.startReplay(Math.max(0, Math.min(this.bars.length - 1, Math.round(l))));
  }

  /** A random start, leaving some history before it and some candles to play after it. */
  replayRandom() {
    const n = this.bars.length;
    if (n < 3) { this.hooks.onReplay?.(this, 'notice', t('chart.replay.notEnough')); return; }
    const lo = Math.max(1, Math.min(100, Math.floor(n * 0.2)));
    const hi = Math.max(lo + 1, n - Math.min(20, Math.floor(n * 0.2)) - 1);
    this.startReplay(Math.min(n - 2, lo + Math.floor(Math.random() * (hi - lo))));
  }

  /** Starts at a date (loading older history when it's further back than the chart has). */
  async replayToDate(value) {
    // The box shows chart time (exchange time for stocks), the same as the time axis.
    const target = value ? Date.parse(`${value}:00Z`) / 1000 : NaN;
    if (!Number.isFinite(target)) return;
    const gen = this.loadGen;
    for (let k = 0; k < 15 && this.feed?.canLoadMore && this.bars[0].time > target; k++) {
      if (!(await this.loadOlder())) break;
      if (gen !== this.loadGen || !this.replayPick) return; // cancelled meanwhile
    }
    if (gen !== this.loadGen || !this.replayPick) return;
    let i = this.indexAtOrBefore(target);
    if (i < 0) {
      this.hooks.onReplay?.(this, 'notice', t('chart.replay.tooFarBack'));
      i = 0;
    }
    this.startReplay(i);
  }

  /** Replays from candle i: candles after it are hidden until played. */
  startReplay(i) {
    const all = this.replay?.all || this.bars;
    if (!all.length) return;
    clearInterval(this.replay?.timer);
    const speed = this.replay?.speed || 1;
    this.replayPick = false;
    this.q('.rp-banner').hidden = true;
    this.q('.rp-pick').hidden = true;
    this.replay = { all, idx: i, playing: false, speed, timer: null, clock: 0 };
    this.bars = all.slice(0, i + 1);
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const width = range ? Math.max(30, range.to - range.from) : 150;
    this.renderAll(false);
    this.chart.timeScale().setVisibleLogicalRange({ from: i - width * 0.8, to: i + width * 0.2 });
    this.replay.clock = this.replayClock();
    this.q('.replay-bar').hidden = false;
    this.q('[data-rp="speed"]').value = String(speed);
    this.syncReplayBar();
    this.setStatus('replay');
    this.hooks.onReplay?.(this, 'start');
  }

  /** Shows the next candle. Returns false at the end of the data. */
  replayStep() {
    const r = this.replay;
    if (!r || this.replayPick || !this.feed) return false;
    if (r.idx >= r.all.length - 1) {
      this.pauseReplay();
      this.hooks.onReplay?.(this, 'end');
      return false;
    }
    r.idx++;
    const bar = r.all[r.idx];
    this.bars.push(bar);
    this.markDirty(this.bars.length - 1);
    r.clock = this.replayClock();
    this.syncReplayBar();
    this.hooks.onReplay?.(this, 'bar', bar);
    return true;
  }

  toggleReplayPlay() { if (this.replay?.playing) this.pauseReplay(); else this.playReplay(); }

  playReplay() {
    const r = this.replay;
    if (!r || r.playing || this.replayPick || !this.feed) return;
    if (r.idx >= r.all.length - 1) { this.hooks.onReplay?.(this, 'end'); return; }
    r.playing = true;
    r.timer = setInterval(() => { if (!this.replayStep()) this.pauseReplay(); }, 1000 / r.speed);
    this.syncReplayBar();
  }

  pauseReplay() {
    const r = this.replay;
    if (!r?.playing) return;
    r.playing = false;
    clearInterval(r.timer);
    r.timer = null;
    this.syncReplayBar();
  }

  setReplaySpeed(speed) {
    const r = this.replay;
    if (!r || !(speed > 0)) return;
    r.speed = speed;
    this.q('[data-rp="speed"]').value = String(speed);
    if (r.playing) { this.pauseReplay(); this.playReplay(); }
  }

  syncReplayBar() {
    const r = this.replay;
    if (!r) return;
    const bar = this.q('.replay-bar');
    const play = bar.querySelector('[data-rp="play"]');
    play.innerHTML = r.playing ? ICON_PAUSE : ICON_PLAY;
    play.classList.toggle('on', r.playing);
    const t = this.lastBar?.time;
    const d = t != null ? new Date(t * 1000) : null;
    const pad = (x) => String(x).padStart(2, '0');
    bar.querySelector('.rp-time').textContent = d
      ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${this.tf.daily ? '' : ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}`
      : '';
    bar.querySelector('[data-rp="step"]').disabled = r.idx >= r.all.length - 1;
  }

  /** Leaves the replay and reloads the live chart. */
  stopReplay() {
    if (this.replayPick) { this.replayPick = false; this.q('.rp-banner').hidden = true; this.q('.rp-pick').hidden = true; }
    if (!this.replay) { this.hooks.onReplay?.(this, 'cancel'); return; }
    this.endReplay();
    this.load();
  }

  endReplay(notice) {
    clearInterval(this.replay?.timer);
    this.replay = null;
    this.q('.replay-bar').hidden = true;
    this.setStatus(this.feedStatus || 'connecting');
    this.hooks.onReplay?.(this, 'stop', notice);
  }

  /** New data while replaying (another symbol or timeframe): continue at the same moment. */
  resumeReplayOn(bars) {
    const clock = this.replay.clock;
    const tz = this.meta.tzOffset || 0;
    let i = bars.length - 1;
    while (i >= 0 && bars[i].time - tz + this.tf.sec > clock + 1) i--;
    if (i < 0) {
      this.endReplay(t('chart.replay.noCandles', { tf: this.tf.label }));
      return;
    }
    this.pauseReplay();
    this.replay.all = bars;
    this.replay.idx = i;
    this.bars = bars.slice(0, i + 1);
    this.q('.replay-bar').hidden = false;
    queueMicrotask(() => { if (this.replay) { this.replay.clock = this.replayClock(); this.syncReplayBar(); this.setStatus('replay'); this.hooks.onReplay?.(this, 'resume'); } });
  }

  // --- paper trading: lines, markers and the quick-trade buttons -------------------
  /**
   * lines: [{ id, price, color, title, style: 'solid'|'dashed', drag }] — the position, its stop loss
   * and take profit, and working orders. Draggable lines report the new price via onPaperDrag.
   */
  setPaperLines(lines) {
    const next = new Map(lines.map((l) => [l.id, l]));
    for (const [id, x] of this.paperLines) {
      if (next.has(id)) continue;
      if (x.line && this.main) { try { this.main.removePriceLine(x.line); } catch { /* gone */ } }
      this.paperLines.delete(id);
    }
    for (const spec of lines) {
      const x = this.paperLines.get(spec.id);
      if (x) x.spec = spec; else this.paperLines.set(spec.id, { spec, line: null });
    }
    this.applyPaperLines();
  }

  applyPaperLines() {
    if (!this.main) return;
    for (const [id, x] of this.paperLines) {
      if (this.drag?.id === id) continue; // being dragged
      const { price, color, title, style } = x.spec;
      const opts = {
        price, color, title, lineWidth: style === 'solid' ? 2 : 1, axisLabelVisible: true,
        lineStyle: style === 'solid' ? LWC.LineStyle.Solid : LWC.LineStyle.Dashed,
      };
      if (x.line) x.line.applyOptions(opts);
      else x.line = this.main.createPriceLine(opts);
    }
  }

  /** The draggable paper line within a few pixels of y, if any. */
  paperHit(y) {
    if (!this.main || !this.paperLines.size) return null;
    let best = null;
    for (const [id, x] of this.paperLines) {
      if (!x.spec.drag || !x.line) continue;
      const c = this.main.priceToCoordinate(x.spec.price);
      if (c == null) continue;
      const d = Math.abs(c - y);
      if (d <= 5 && (!best || d < best.d)) best = { id, d };
    }
    return best?.id || null;
  }

  beginPaperDrag(p) {
    const id = this.paperHit(p.y);
    if (!id) return false;
    const x = this.paperLines.get(id);
    this.drag = { id, price: x.spec.price };
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    const prec = this.meta.precision ?? 2;
    const move = (ev) => {
      const q = this.paneCoords(ev, true);
      if (!q) return;
      const price = this.main.coordinateToPrice(q.y);
      if (!Number.isFinite(price) || price <= 0) return;
      this.drag.price = Number(price.toFixed(prec));
      x.line?.applyOptions({ price: this.drag.price });
      this.dragged = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      const { price } = this.drag;
      this.drag = null;
      this.chartEl.style.cursor = '';
      if (price !== x.spec.price) this.hooks.onPaperDrag?.(this, id, price);
      this.applyPaperLines(); // snap back unless the app moved it
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return true;
  }

  /** fills: [{ side, price, time (UTC seconds), reason }] for this chart's symbol: arrows on the candles. */
  setPaperFills(fills) {
    this.paperFills = fills;
    this.applyPaperMarkers();
  }

  applyPaperMarkers() {
    if (!this.main) return;
    if (!this.paperFills.length && !this.paperMarkers) return;
    if (!this.paperMarkers) this.paperMarkers = LWC.createSeriesMarkers(this.main, []);
    const tz = this.meta.tzOffset || 0;
    const markers = [];
    for (const f of this.paperFills) {
      if (f.time == null) continue;
      const i = this.indexAtOrBefore(f.time + tz);
      if (i < 0) continue;
      const buy = f.side === 'buy';
      markers.push({
        time: this.bars[i].time, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? '#4FA3F7' : '#EC5246', text: t(buy ? 'chart.fillBuy' : 'chart.fillSell', { qty: +f.qty.toPrecision(6) }),
      });
    }
    markers.sort((a, b) => a.time - b.time);
    this.paperMarkers.setMarkers(markers);
  }

  /** Buy / sell buttons on the chart (shown while trading or replaying). */
  setQuickTrade(on, qty) {
    const el = this.q('.qt');
    el.hidden = !on || this.replayPick;
    this.el.classList.toggle('qt-on', !el.hidden);
    const input = this.q('.qt-qty');
    if (qty != null && document.activeElement !== input) input.value = qty;
    if (on) this.updateQuickTrade();
  }

  updateQuickTrade() {
    const el = this.q('.qt');
    if (el.hidden) return;
    const px = this.lastBar ? this.formatPrice(this.lastBar.close) : '—';
    el.querySelectorAll('.qt-px').forEach((b) => { b.textContent = px; });
  }

  // --- legend ------------------------------------------------------------------
  updateTitle() {
    const m = this.meta;
    const ticker = this.ticker;
    const named = m.name && m.name !== ticker && this.feed;
    this.q('.lg-name').textContent = named ? `${ticker} · ${m.name}` : ticker;
    this.q('.lg-meta').textContent = `${this.tf.label} · ${(this.feed && m.exchange) || sourceName(this.state.symbol)}`;
  }

  entryLabel(entry) {
    if (entry.def) return indicatorLabel(entry.def, entry.inst);
    return entry.name || scriptStore.get(entry.inst.scriptId)?.name || t('chart.script');
  }

  buildLegend() {
    const overlayBox = this.q('.lg-ind');
    const paneBox = this.q('.pane-legends');
    overlayBox.innerHTML = '';
    paneBox.innerHTML = '';
    for (const e of this.compareEntries.values()) {
      const row = document.createElement('div');
      row.className = 'lg-row';
      row.dataset.cmp = e.c.symbol;
      row.innerHTML = `<i class="lg-dot" style="background:${e.c.color}"></i><span class="lg-name">${esc(displayTicker(e.c.symbol))}</span>
        <span class="lg-vals">${e.error ? `<span class="lg-err">${esc(e.error)}</span>` : ''}</span>
        <span class="lg-actions"><button data-act="rm-cmp" title="${t('common.remove')}" aria-label="${t('common.remove')}">${ICON_X}</button></span>`;
      overlayBox.append(row);
      e.row = row;
    }
    for (const entry of this.live.values()) {
      const row = document.createElement('div');
      const hidden = isHidden(entry.inst);
      row.className = hidden ? 'lg-row off' : 'lg-row';
      row.dataset.id = entry.inst.id;
      row.innerHTML = `<span class="lg-name">${esc(this.entryLabel(entry))}</span>
        <span class="lg-vals">${entry.error ? `<span class="lg-err">⚠ ${esc(entry.error)}</span>` : ''}</span>
        <span class="lg-actions">
          <button data-act="eye" title="${t(hidden ? 'chart.indShow' : 'chart.indHide')}" aria-label="${t(hidden ? 'chart.indShow' : 'chart.indHide')}" aria-pressed="${!hidden}">${hidden ? ICON_EYE_OFF : ICON_EYE}</button>
          ${entry.script ? `<button data-act="code" title="${t('chart.editScript')}" aria-label="${t('chart.editScript')}">${ICON_CODE}</button>` : ''}
          <button data-act="settings" title="${t('common.settings')}" aria-label="${t('common.settings')}">${ICON_GEAR}</button>
          <button data-act="remove" title="${t('common.remove')}" aria-label="${t('common.remove')}">${ICON_X}</button>
        </span>`;
      entry.row = row;
      entry.paneLegend = null;
      if (!entry.def || entry.def.overlay || !entry.series.length) {
        overlayBox.append(row);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'pane-legend';
        wrap.append(row);
        paneBox.append(wrap);
        entry.paneLegend = wrap;
      }
    }
    this.updateLegend(this.lastCrosshair);
    requestAnimationFrame(() => this.positionPaneLegends());
  }

  positionPaneLegends() {
    if (this.destroyed) return;
    const top0 = this.chartEl.getBoundingClientRect().top;
    for (const entry of this.live.values()) {
      if (!entry.paneLegend) continue;
      let paneEl = null;
      try { paneEl = entry.series[0].api.getPane().getHTMLElement(); } catch { /* being removed */ }
      if (paneEl) entry.paneLegend.style.top = `${paneEl.getBoundingClientRect().top - top0 + 4}px`;
    }
  }

  updateLegend(param) {
    this.lastCrosshair = param;
    const ohlc = this.q('.lg-ohlc');
    const bars = this.bars;
    if (!bars.length) { ohlc.innerHTML = ''; return; }
    let i = bars.length - 1;
    if (param?.time != null) {
      const k = this.indexOfTime(param.time);
      if (k >= 0) i = k;
    }
    const b = bars[i];
    const prev = bars[i - 1];
    const cls = b.close >= b.open ? 'up' : 'down';
    const chg = prev ? b.close - prev.close : 0;
    const pct = prev ? (chg / prev.close) * 100 : 0;
    const sign = chg >= 0 ? '+' : '';
    const f = (v) => this.formatPrice(v);
    ohlc.innerHTML = `<span>O<b class="${cls}">${f(b.open)}</b></span>
      <span>H<b class="${cls}">${f(b.high)}</b></span>
      <span>L<b class="${cls}">${f(b.low)}</b></span>
      <span>C<b class="${cls}">${f(b.close)}</b></span>
      <b class="${chg >= 0 ? 'up' : 'down'}">${sign}${f(chg)} (${sign}${fixed(pct, 2)}%)</b>`;
    if (this.ext) {
      const ref = bars[bars.length - 1].close; // last regular-session close
      const d = ((this.ext.price - ref) / ref) * 100;
      const name = t(`chart.ext.${this.ext.label.toLowerCase()}`); // Pre-market, After hours, Overnight
      ohlc.innerHTML += `<span class="lg-ext">${name}<b>${f(this.ext.price)}</b>
        <b class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${fixed(d, 2)}%</b></span>`;
    }

    for (const entry of this.live.values()) {
      if (!entry.row || !entry.out || entry.error) continue;
      if (isHidden(entry.inst)) { entry.row.querySelector('.lg-vals').innerHTML = ''; continue; }
      const k = Math.min(i, (entry.outLen ?? bars.length) - 1);
      let html = entry.series.map(({ plot }) => {
        const v = entry.out[plot.key]?.[k];
        if (plot.optional && !Number.isFinite(v)) return '';
        let color = plot.colorFn && Number.isFinite(v) ? plot.colorFn(k, entry.out, bars, plot.key)
          : plot.colorsArr?.[k] || plotColor(entry.inst, plot);
        color = color.replace(/,\s*[\d.]+\)$/, ', 1)'); // legend text is always opaque
        return `<b style="color:${color}">${this.formatIndicator(entry.def, v)}</b>`;
      }).join('');
      const s = entry.report?.summary;
      if (s) {
        const pct = s.netProfitPct;
        html += `<span class="lg-strat">${t('chart.stratTrades', { n: s.trades })} · <b class="${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${fixed(pct, 2)}%</b></span>`;
      }
      entry.row.querySelector('.lg-vals').innerHTML = html;
    }
    for (const e of this.compareEntries.values()) {
      if (!e.row || e.error) continue;
      const v = e.series.data?.()[i]?.value;
      e.row.querySelector('.lg-vals').innerHTML = Number.isFinite(v) ? `<b style="color:${e.c.color}">${formatNumber(v, v < 10 ? 4 : 2)}</b>` : '';
    }
  }

  // --- indicator settings ----------------------------------------------------------
  openSettings(id, anchor) {
    const entry = this.live.get(id);
    if (!entry?.def) return;
    const { inst, def } = entry;
    const el = settings.el;
    const colorPlots = def.plots.filter((p) => !p.colorFn && !p.colorsArr);
    // Every value is escaped: settings come from saved state and from scripts (see coerceParams).
    const field = (p) => {
      const v = inst.params[p.key] ?? p.def;
      const key = esc(p.key);
      if (p.type === 'select') {
        return `<select data-param="${key}">${(p.options || []).map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(optionLabel(p, o))}</option>`).join('')}</select>`;
      }
      if (p.type === 'bool') return `<input type="checkbox" data-param="${key}"${v ? ' checked' : ''}>`;
      if (p.type === 'text') return `<input type="text" data-param="${key}" value="${esc(v)}">`;
      return `<input type="number" data-param="${key}" value="${esc(v)}" min="${esc(p.min)}" max="${esc(p.max)}" step="${esc(p.step)}">`;
    };
    el.innerHTML = `
      <div class="pop-title">${esc(def.name)}</div>
      ${def.params.map((p) => `<label class="pop-field"><span>${esc(p.label)}</span>${field(p)}</label>`).join('')}
      ${colorPlots.map((p) => `
        <label class="pop-field"><span>${t('chart.plotColor', { title: esc(p.title) })}</span>
          <input type="color" data-color="${esc(p.key)}" value="${/^#[0-9a-f]{6}$/i.test(plotColor(inst, p)) ? plotColor(inst, p) : '#4FA3F7'}">
        </label>`).join('')}
      ${!def.params.length && !colorPlots.length ? `<p class="pop-note">${t('chart.noSettings')}</p>` : ''}
      <div class="pop-actions">
        <button class="btn-ghost" data-act="defaults">${t('chart.defaults')}</button>
        <button class="btn-primary" data-act="close">${t('common.done')}</button>
      </div>`;
    el.hidden = false;
    settings.view = this;
    settings.id = id;
    const r = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))}px`;
    el.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 12))}px`;
  }

  onSettingsInput(id, t) {
    const entry = this.live.get(id);
    if (!entry?.def) return;
    if (t.dataset.param) {
      const spec = entry.def.params.find((p) => p.key === t.dataset.param);
      if (!spec) return;
      let v;
      if (spec.type === 'bool') v = t.checked;
      else if (spec.type === 'select' || spec.type === 'text') v = t.value.slice(0, LIMITS.text);
      else {
        v = Number(t.value);
        if (t.value === '' || !Number.isFinite(v) || v < spec.min || v > spec.max) return;
        if (spec.step >= 1) v = Math.round(v);
      }
      entry.inst.params[spec.key] = v;
      if (this.bars.length) this.computeAndSet(entry);
      entry.row.querySelector('.lg-name').textContent = this.entryLabel(entry);
    } else if (t.dataset.color) {
      entry.inst.colors = { ...entry.inst.colors, [t.dataset.color]: t.value };
      entry.series.find((x) => x.plot.key === t.dataset.color)?.api.applyOptions({ color: t.value });
    }
    this.updateLegend(this.lastCrosshair);
    this.hooks.onChange?.(this);
  }

  resetIndicator(id) {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.inst.params = entry.script ? {} : defaultParams(entry.inst.type);
    entry.inst.colors = {};
    closeSettings();
    this.rebuildSeries();
    this.hooks.onChange?.(this);
  }
}
