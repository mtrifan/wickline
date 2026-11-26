// Drawing tools, implemented as a Lightweight Charts series primitive.
// Points are stored as { time, price } so drawings survive zooming, scrolling,
// history loading and chart-type changes. Saved per symbol in localStorage.

import { t } from './i18n.js';
import { fixed, store as settings } from './util.js';
import { STROKE_TOOLS, strokeOf } from './stroke.js';
import { activeLevels, fibOf, labelText, levelPrice } from './fib.js';
import { LABEL_TOOLS } from './point-editor.js';

export const TOOLS = {
  cursor: { label: t('draw.tool.cursor'), points: 0 },
  trend: { label: t('draw.tool.trend'), points: 2, color: '#4FA3F7' },
  ray: { label: t('draw.tool.ray'), points: 2, color: '#4FA3F7' },
  extended: { label: t('draw.tool.extended'), points: 2, color: '#4FA3F7' },
  arrow: { label: t('draw.tool.arrow'), points: 2, color: '#EC5246' },
  hline: { label: t('draw.tool.hline'), points: 1, color: '#FF9800' },
  hray: { label: t('draw.tool.hray'), points: 1, color: '#FF9800' },
  vline: { label: t('draw.tool.vline'), points: 1, color: '#8E8A82' },
  rect: { label: t('draw.tool.rect'), points: 2, color: '#9C27B0' },
  channel: { label: t('draw.tool.channel'), points: 3, color: '#4FA3F7' },
  text: { label: t('draw.tool.text'), points: 1, color: '#D9D5CD' },
  fib: { label: t('draw.tool.fib'), points: 2, color: '#8E8A82' },
  measure: { label: t('draw.tool.measure'), points: 2, color: '#4FA3F7' },
  long: { label: t('draw.tool.long'), points: 2, color: '#34B886' },
  short: { label: t('draw.tool.short'), points: 2, color: '#EC5246' },
  avwap: { label: t('draw.tool.avwap'), points: 1, color: '#E040FB' },
  arrowUp: { label: t('draw.tool.arrowUp'), points: 1, color: '#34B886', symbol: true },
  arrowDown: { label: t('draw.tool.arrowDown'), points: 1, color: '#EC5246', symbol: true },
};

/** Arrow symbols with an optional label; `size` is the label's font size in px and scales the arrow. */
export const SYMBOL_SIZE = { min: 8, max: 64, default: 14 };
export const isSymbol = (type) => !!TOOLS[type]?.symbol;

/**
 * Anchored VWAP: from the bar at index `from` on, the running average of each bar's typical price
 * (high + low + close) / 3 weighted by its volume. Bars without volume (forex, indices) all count
 * the same, so it's still a useful average there. Returns one value per bar from `from` on.
 */
export function anchoredVwap(bars, from) {
  const out = [];
  if (from < 0 || from >= bars.length) return out;
  const anyVolume = bars.slice(from).some((b) => b.volume > 0);
  let pv = 0, v = 0;
  for (let i = from; i < bars.length; i++) {
    const b = bars[i];
    const w = anyVolume ? (b.volume > 0 ? b.volume : 0) : 1;
    pv += ((b.high + b.low + b.close) / 3) * w;
    v += w;
    out.push(v > 0 ? pv / v : (b.high + b.low + b.close) / 3);
  }
  return out;
}

/** Magnet: off, weak (snaps to a bar's open/high/low/close when the pointer is near) or strong (always). */
export const MAGNET_MODES = ['off', 'weak', 'strong'];
const MAGNET_PX = 14;

/** Two-point line tools: holding Shift while placing or dragging one makes it horizontal (0°). */
const LINE_TOOLS = new Set(['trend', 'ray', 'extended', 'arrow', 'channel']);

export const DRAW_COLORS = ['#4FA3F7', '#00BCD4', '#34B886', '#FFEB3B', '#FF9800', '#EC5246', '#E040FB', '#D9D5CD'];

const HIT_PX = 6;
const HANDLE_PX = 8;

function rgba(hex, a) {
  if (!hex?.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Extends the segment p1→p2 far past p2 (and past p1 when both is true); the canvas clips it. */
function extend(x1, y1, x2, y2, both) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const k = 5000 / len;
  const ex = [x2 + (x2 - x1) * k, y2 + (y2 - y1) * k];
  const sx = both ? [x1 - (x2 - x1) * k, y1 - (y2 - y1) * k] : [x1, y1];
  return [sx[0], sx[1], ex[0], ex[1]];
}

const store = {
  load(key) {
    try { return JSON.parse(localStorage.getItem(`wickline.drawings.${key}`)) || []; } catch { return []; }
  },
  save(key, items) {
    try { localStorage.setItem(`wickline.drawings.${key}`, JSON.stringify(items)); } catch { /* ignore */ }
  },
};

const clampSize = (v) => Math.max(SYMBOL_SIZE.min, Math.min(SYMBOL_SIZE.max, Math.round(Number(v)) || SYMBOL_SIZE.default));
const sizeStore = {
  load() {
    try { return clampSize(localStorage.getItem('wickline.symbolSize') ?? SYMBOL_SIZE.default); } catch { return SYMBOL_SIZE.default; }
  },
  save(v) { try { localStorage.setItem('wickline.symbolSize', String(v)); } catch { /* ignore */ } },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const POINT_KEYS = ['p1', 'p2', 'p3'];

export class DrawingLayer {
  constructor({ formatPrice, onToolChange, onSelect, theme }) {
    this.formatPrice = formatPrice;
    this.onToolChange = onToolChange;
    this.onSelect = onSelect;
    this.theme = theme || { bg: '#0F1012', text: '#D9D5CD' };
    this.items = [];
    this.pending = null;
    this.selectedId = null;
    this.tool = 'cursor';
    this.key = null;
    this.bars = [];
    this.tfSec = 3600;
    this.chart = null;
    this.series = null;
    this.drag = null;
    const saved = settings.get('magnet', 'off');
    this.magnet = MAGNET_MODES.includes(saved) ? saved : 'off';
    this.symbolSize = sizeStore.load();
    this.focusText = false;      // a symbol was just placed: the draw bar should focus its label box
    this.hint = null;            // { time, price }: where the magnet is snapping right now
    this.shift = false;          // Shift is held: lines being placed or dragged snap to horizontal
    this._lastXY = null;         // last pointer position, to re-apply Shift without moving the mouse
    this._request = null;
    this._paneViews = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this._draw(t) }) }];
    this._axisViews = [];
  }

  // --- ISeriesPrimitive -----------------------------------------------------
  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this._request = requestUpdate;
    this._onKey = (e) => { if (e.key === 'Shift') this.setShift(e.type === 'keydown'); };
    this._onBlur = () => this.setShift(false);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKey);
      window.addEventListener('blur', this._onBlur);
    }
  }
  detached() {
    this.series = null;
    this._request = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKey);
      window.removeEventListener('blur', this._onBlur);
    }
    this.shift = false;
  }
  updateAllViews() {}
  paneViews() { return this._paneViews; }
  priceAxisViews() { return this._axisViews; }

  // --- context ----------------------------------------------------------------
  setContext(symbolKey, tfSec) {
    this.key = symbolKey;
    this.tfSec = tfSec;
    this.items = store.load(symbolKey).filter((d) => TOOLS[d.type]);
    this.pending = null;
    this.select(null);
    this._changed(false);
  }

  setBars(bars) { this.bars = bars; this._request?.(); }
  setTheme(theme) { this.theme = theme; this._request?.(); }

  setTool(tool) {
    this.tool = tool;
    this.pending = null;
    if (tool !== 'cursor') this.select(null);
    this._request?.();
  }

  get selected() { return this.items.find((d) => d.id === this.selectedId) || null; }

  select(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this._request?.();
    this.onSelect?.(this.selected);
  }

  updateSelected(patch) {
    const d = this.selected;
    if (!d) return;
    if ('size' in patch && isSymbol(d.type)) {
      patch = { ...patch, size: clampSize(patch.size) };
      this.symbolSize = patch.size;
      sizeStore.save(patch.size);
    }
    Object.assign(d, patch);
    this._changed(true);
    this.onSelect?.(d);
  }

  setMagnet(mode) {
    if (!MAGNET_MODES.includes(mode)) return;
    this.magnet = mode;
    this._setHint(null);
  }

  _setHint(h) {
    if (h?.time === this.hint?.time && h?.price === this.hint?.price) return;
    this.hint = h;
    this._request?.();
  }

  /** The bar's open, high, low or close nearest to the pointer, if the magnet is on and in range. */
  _magnetPrice(logical, y, price) {
    if (this.magnet === 'off') return null;
    const bar = this.bars[Math.round(logical)];
    if (!bar) return null;
    let best = null, bestD = Infinity;
    for (const v of [bar.open, bar.high, bar.low, bar.close]) {
      const vy = Number.isFinite(v) ? this._y(v) : null;
      if (vy != null && Math.abs(vy - y) < bestD) { best = v; bestD = Math.abs(vy - y); }
    }
    return best != null && (this.magnet === 'strong' || bestD <= MAGNET_PX) && best !== price ? best : null;
  }

  /** Shift pressed or released: re-apply it to the line being placed or dragged right away. */
  setShift(on) {
    if (this.shift === on) return;
    this.shift = on;
    if (!this._lastXY) return;
    if (this.pending) this.handleMove({ point: this._lastXY });
    else if (this.drag) this.dragMove(this._lastXY.x, this._lastXY.y);
  }

  /** `p` flattened to the anchor's price (a 0° line) when Shift is on and the tool is a line. */
  _flat(type, anchor, p, shift) {
    return shift && LINE_TOOLS.has(type) && anchor ? { time: p.time, price: anchor.price } : p;
  }

  cancel() {
    if (this.pending) { this.pending = null; this._finishTool(); return true; }
    if (this.selectedId) { this.select(null); return true; }
    return false;
  }

  deleteSelected() {
    if (!this.selectedId) return false;
    this.items = this.items.filter((d) => d.id !== this.selectedId);
    this.select(null);
    this._changed(true);
    return true;
  }

  clearAll() {
    this.items = [];
    this.pending = null;
    this.select(null);
    this._changed(true);
  }

  _changed(save) {
    if (save && this.key) store.save(this.key, this.items);
    this._axisViews = this.items.filter((d) => d.type === 'hline' || d.type === 'hray').map((d) => ({
      coordinate: () => this.series?.priceToCoordinate(d.p1.price) ?? -1000,
      text: () => this.formatPrice(d.p1.price),
      textColor: () => '#FFFFFF',
      backColor: () => d.color,
      visible: () => true,
      tickVisible: () => true,
    }));
    this._request?.();
  }

  _finishTool() {
    this.tool = 'cursor';
    this._setHint(null);
    this.onToolChange?.('cursor');
    this._request?.();
  }

  /**
   * A long/short placed with both clicks on one candle (or one price) would be a box with no width
   * (or no height): only its labels showing, and nothing to grab. Give it a ready-made size instead:
   * about a sixth of the visible bars wide, the target a little above (long) or below (short) the entry.
   */
  _sizePosition(item) {
    if (!this.chart || !this.series) return;
    const l1 = this.logicalFromTime(item.p1.time), l2 = this.logicalFromTime(item.p2.time);
    if (Math.abs(l2 - l1) < 1) {
      const range = this.chart.timeScale().getVisibleLogicalRange?.();
      const span = range ? range.to - range.from : 60;
      item.p2.time = this.timeFromLogical(Math.round(l1) + Math.max(5, Math.round(span / 6)));
    }
    const y1 = this._y(item.p1.price), y2 = this._y(item.p2.price);
    if (y1 != null && (y2 == null || Math.abs(y2 - y1) < 6)) {
      const h = this.chart.panes?.()[0]?.getHeight?.() || 400;
      const dy = Math.max(30, h * 0.08) * (item.type === 'long' ? -1 : 1);
      const price = this.series.coordinateToPrice(y1 + dy);
      if (price != null) item.p2.price = price;
    }
  }

  // --- time <-> logical index (works between bars and beyond the last bar) ---
  logicalFromTime(t) {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (t <= b[0].time) return (t - b[0].time) / this.tfSec;
    if (t >= b[n - 1].time) return n - 1 + (t - b[n - 1].time) / this.tfSec;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time <= t) lo = mid; else hi = mid;
    }
    return lo + (t - b[lo].time) / (b[hi].time - b[lo].time);
  }

  timeFromLogical(l) {
    const b = this.bars, n = b.length;
    if (!n) return 0;
    if (l <= 0) return Math.round(b[0].time + l * this.tfSec);
    if (l >= n - 1) return Math.round(b[n - 1].time + (l - (n - 1)) * this.tfSec);
    const i = Math.floor(l), f = l - i;
    return Math.round(b[i].time + f * (b[i + 1].time - b[i].time));
  }

  /** An anchored VWAP's bar index and values (kept while the bars and the anchor stay the same). */
  _vwap(d) {
    const bars = this.bars, n = bars.length;
    const from = Math.max(0, Math.round(this.logicalFromTime(d.p1.time)));
    const key = `${from}|${n}|${n ? bars[n - 1].time : 0}|${n ? bars[n - 1].close : 0}|${n ? bars[0].time : 0}`;
    if (d._vwapKey !== key || d._vwapBars !== bars) {
      Object.defineProperty(d, '_vwapCache', { value: { from, values: anchoredVwap(bars, from) }, writable: true, configurable: true, enumerable: false });
      Object.defineProperty(d, '_vwapKey', { value: key, writable: true, configurable: true, enumerable: false });
      Object.defineProperty(d, '_vwapBars', { value: bars, writable: true, configurable: true, enumerable: false });
    }
    return d._vwapCache;
  }

  _x(time) { return this.chart.timeScale().logicalToCoordinate(this.logicalFromTime(time)); }
  _y(price) { return this.series.priceToCoordinate(price); }

  /**
   * Chart position under (x, y) in the price pane, with time snapped to a bar. With `magnet`, the price
   * also snaps to that bar's open/high/low/close when the magnet is on (`snapped` says whether it did).
   */
  _point(x, y, snap = true, magnet = false) {
    if (!this.series || !this.chart) return null;
    const logical = this.chart.timeScale().coordinateToLogical(x);
    let price = this.series.coordinateToPrice(y);
    if (logical == null || price == null) return null;
    const m = magnet ? this._magnetPrice(logical, y, price) : null;
    if (m != null) price = m;
    return { logical, time: this.timeFromLogical(snap ? Math.round(logical) : logical), price, snapped: m != null };
  }

  /** Price on the line p1→p2 at a given time (for parallel channels). */
  _linePriceAt(p1, p2, time) {
    const l1 = this.logicalFromTime(p1.time), l2 = this.logicalFromTime(p2.time), l = this.logicalFromTime(time);
    if (l2 === l1) return p1.price;
    return p1.price + ((p2.price - p1.price) * (l - l1)) / (l2 - l1);
  }

  // --- creating drawings ----------------------------------------------------------
  /** Returns true when the click was used by the drawing layer. */
  handleClick(param) {
    if (this.tool === 'cursor') {
      if (!param.point) return false;
      const hit = this.hitTest(param.point.x, param.point.y);
      this.select(hit);
      return !!hit;
    }
    if (!param.point) return false;
    const pt = this._point(param.point.x, param.point.y, true, true);
    if (!pt) return false;
    const shift = param.shift ?? this.shift;
    const p = { time: pt.time, price: pt.price };
    const spec = TOOLS[this.tool];
    if (spec.points === 1) {
      const item = { id: crypto.randomUUID(), type: this.tool, p1: p, p2: { ...p }, color: spec.color };
      if (this.tool === 'text') item.text = t('draw.tool.text');
      if (spec.symbol) { item.text = ''; item.size = this.symbolSize; this.focusText = true; }
      this.items.push(item);
      this._changed(true);
      this._finishTool();
      this.select(item.id);
      return true;
    }
    if (!this.pending) {
      this.pending = { id: crypto.randomUUID(), type: this.tool, p1: p, p2: { ...p }, color: spec.color, step: 1 };
      if (this.tool === 'channel') this.pending.p3 = { ...p };
      this._request?.();
      return true;
    }
    if (this.pending.type === 'channel' && this.pending.step === 1) {
      this.pending.p2 = this._flat('channel', this.pending.p1, p, shift);
      this.pending.p3 = { ...this.pending.p2 };
      this.pending.step = 2;
      this._request?.();
      return true;
    }
    if (this.pending.type === 'channel') this.pending.p3 = p;
    else this.pending.p2 = this._flat(this.pending.type, this.pending.p1, p, shift);
    const item = this.pending;
    delete item.step;
    if (item.type === 'long' || item.type === 'short') {
      this._sizePosition(item);
      // Stop starts at the same distance on the other side (1:1 risk/reward); drag it to adjust.
      item.p3 = { time: item.p1.time, price: item.p1.price - (item.p2.price - item.p1.price) };
    }
    this.items.push(item);
    this.pending = null;
    this._changed(true);
    this._finishTool();
    this.select(item.id);
    return true;
  }

  handleMove(param) {
    if (!param.point) { this._setHint(null); return; }
    this._lastXY = { x: param.point.x, y: param.point.y };
    if (this.drag) return; // dragMove owns the pointer while a drawing is being dragged
    if (!this.pending && this.tool === 'cursor') { this._setHint(null); return; }
    const pt = this._point(param.point.x, param.point.y, true, true);
    if (!pt) return;
    const shift = param.sourceEvent ? !!param.sourceEvent.shiftKey : this.shift;
    const p = { time: pt.time, price: pt.price };
    let end = p;
    if (this.pending) {
      if (this.pending.type === 'channel' && this.pending.step === 2) this.pending.p3 = p;
      else end = this.pending.p2 = this._flat(this.pending.type, this.pending.p1, p, shift);
    }
    this._setHint(pt.snapped && end.price === pt.price ? { time: end.time, price: end.price } : null);
    this._request?.();
  }

  // --- editing: drag a drawing or one of its handles --------------------------------
  _handles(d) {
    const pts = [];
    const x1 = this._x(d.p1.time), y1 = this._y(d.p1.price);
    switch (d.type) {
      case 'hline': pts.push(['p1', this.chart.timeScale().width() / 2, y1]); break;
      case 'hray': case 'text': case 'arrowUp': case 'arrowDown': pts.push(['p1', x1, y1]); break;
      case 'avwap': { // the handle sits on the line at its anchor bar
        const { values } = this._vwap(d);
        pts.push(['p1', x1, values.length ? this._y(values[0]) : y1]);
        break;
      }
      case 'vline': pts.push(['p1', x1, 40]); break;
      case 'long': case 'short':
        pts.push(['p1', x1, y1], ['p2', this._x(d.p2.time), this._y(d.p2.price)]);
        if (d.p3) pts.push(['p3', x1, this._y(d.p3.price)]); // not while it's being placed
        break;
      case 'channel': {
        const off = d.p3.price - this._linePriceAt(d.p1, d.p2, d.p3.time);
        pts.push(['p1', x1, y1], ['p2', this._x(d.p2.time), this._y(d.p2.price)],
          ['p3', (x1 + this._x(d.p2.time)) / 2, this._y((d.p1.price + d.p2.price) / 2 + off)]);
        break;
      }
      default: pts.push(['p1', x1, y1], ['p2', this._x(d.p2.time), this._y(d.p2.price)]);
    }
    return pts.filter(([, x, y]) => x != null && y != null);
  }

  /** Starts dragging when (x, y) is on the selected drawing's handle or on any drawing. */
  beginDrag(x, y) {
    if (this.tool !== 'cursor' || !this.series) return false;
    const sel = this.selected;
    if (sel) {
      const h = this._handles(sel).find(([, hx, hy]) => Math.hypot(hx - x, hy - y) <= HANDLE_PX);
      if (h) { this.drag = { item: sel, handle: h[0], start: this._point(x, y, false), orig: clone(sel) }; return !!this.drag.start; }
    }
    const id = this.hitTest(x, y);
    if (!id) return false;
    this.select(id);
    const item = this.selected;
    this.drag = { item, handle: 'body', start: this._point(x, y, false), orig: clone(item) };
    return !!this.drag.start;
  }

  dragMove(x, y, shift) {
    const d = this.drag;
    if (!d) return;
    this._lastXY = { x, y };
    if (shift != null) this.shift = shift;
    const pt = this._point(x, y, false, d.handle !== 'body');
    if (!pt) return;
    const { item, orig } = d;
    if (d.handle === 'body') {
      const dl = Math.round(pt.logical - d.start.logical);
      const dp = pt.price - d.start.price;
      for (const k of POINT_KEYS) {
        if (!orig[k]) continue;
        item[k] = { time: this.timeFromLogical(this.logicalFromTime(orig[k].time) + dl), price: orig[k].price + dp };
      }
    } else if (d.handle === 'p3' && (item.type === 'long' || item.type === 'short')) {
      item.p3 = { time: item.p1.time, price: pt.price };
    } else {
      const p = { time: this.timeFromLogical(Math.round(pt.logical)), price: pt.price };
      // Shift: keep the dragged end level with the other end (a 0° line).
      const other = d.handle === 'p1' ? item.p2 : d.handle === 'p2' ? item.p1 : null;
      item[d.handle] = this._flat(item.type, other, p, this.shift);
      this._setHint(pt.snapped && item[d.handle].price === pt.price ? { time: p.time, price: p.price } : null);
    }
    this._changed(false);
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this._setHint(null);
    this._changed(true);
    this.onSelect?.(this.selected);
  }

  hitTest(x, y) {
    if (!this.series || !this.chart) return null;
    let best = null, bestD = HIT_PX;
    for (const d of this.items) {
      const dist = this._distance(d, x, y);
      if (dist != null && dist <= bestD) { best = d.id; bestD = dist; }
    }
    return best;
  }

  _distance(d, x, y) {
    const x1 = this._x(d.p1.time), y1 = this._y(d.p1.price);
    const x2 = this._x(d.p2.time), y2 = this._y(d.p2.price);
    if (y1 == null) return null;
    const inBox = (ax, ay, bx, by) => x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by);
    switch (d.type) {
      case 'hline': return Math.abs(y - y1);
      case 'hray': return x1 != null && x >= x1 - HIT_PX ? Math.abs(y - y1) : null;
      case 'avwap': {
        const { from, values } = this._vwap(d);
        const i = Math.round(this.chart.timeScale().coordinateToLogical(x) ?? -1) - from;
        if (i < 0 || i >= values.length) return null;
        const vy = this._y(values[i]);
        return vy == null ? null : Math.abs(y - vy);
      }
      case 'vline': return x1 == null ? null : Math.abs(x - x1);
      case 'text': return x1 != null && x >= x1 - 4 && x <= x1 + (d._w || 40) + 4 && y >= y1 - 16 && y <= y1 + 4 ? 0 : null;
      case 'arrowUp': case 'arrowDown': {
        if (x1 == null) return null;
        const b = this._symbolBox(d, x1, y1);
        return x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 3 && y <= b.bottom + 3 ? 0 : null;
      }
      case 'trend': case 'arrow':
        return x1 == null || x2 == null || y2 == null ? null : distToSegment(x, y, x1, y1, x2, y2);
      case 'ray': case 'extended': {
        if (x1 == null || x2 == null || y2 == null) return null;
        const [a, b, c, e] = extend(x1, y1, x2, y2, d.type === 'extended');
        return distToSegment(x, y, a, b, c, e);
      }
      case 'rect': case 'measure':
        return x1 == null || x2 == null || y2 == null ? null : inBox(x1, y1, x2, y2) ? 0 : null;
      case 'long': case 'short': {
        // A few pixels of margin, so even a very thin position can be picked up.
        const y3 = this._y(d.p3.price);
        if (x1 == null || x2 == null || y2 == null || y3 == null) return null;
        const m = HIT_PX;
        return x >= Math.min(x1, x2) - m && x <= Math.max(x1, x2) + m && y >= Math.min(y1, y2, y3) - m && y <= Math.max(y1, y2, y3) + m ? 0 : null;
      }
      case 'channel': {
        if (x1 == null || x2 == null || y2 == null) return null;
        const off = d.p3.price - this._linePriceAt(d.p1, d.p2, d.p3.time);
        const ya = this._y(d.p1.price + off), yb = this._y(d.p2.price + off);
        if (ya == null || yb == null) return null;
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        if (x < minX - HIT_PX || x > maxX + HIT_PX) return null;
        const t = maxX === minX ? 0 : (x - x1) / (x2 - x1);
        const yl1 = y1 + (y2 - y1) * t, yl2 = ya + (yb - ya) * t;
        return y >= Math.min(yl1, yl2) - HIT_PX && y <= Math.max(yl1, yl2) + HIT_PX ? 0 : null;
      }
      case 'fib': {
        const g = this._fibGeometry(d, this.chart.timeScale().width());
        if (!g || x < g.left - HIT_PX || x > g.right + HIT_PX) return null;
        let m = Infinity;
        for (const lv of g.levels) m = Math.min(m, Math.abs(y - lv.y));
        return m;
      }
      default: return null;
    }
  }

  // --- rendering --------------------------------------------------------------
  _draw(target) {
    if (!this.series || !this.chart) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const list = this.pending ? [...this.items, this.pending] : this.items;
      for (const d of list) {
        ctx.save();
        try { this._drawItem(ctx, d, mediaSize, d === this.pending || d.id === this.selectedId); } catch { /* skip */ }
        ctx.restore();
      }
      const h = this.hint;
      const hx = h ? this._x(h.time) : null, hy = h ? this._y(h.price) : null;
      if (hx != null && hy != null) { // the magnet is snapping here
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = this.theme.text;
        ctx.stroke();
      }
    });
  }

  /** A Fib's options, the span of its lines on screen, and each enabled level with its price and y. */
  _fibGeometry(d, width) {
    const x1 = this._x(d.p1.time), x2 = this._x(d.p2.time);
    if (x1 == null || x2 == null) return null;
    const cfg = fibOf(d);
    const levels = [];
    for (const lv of activeLevels(cfg)) {
      const price = levelPrice(d.p1.price, d.p2.price, lv.value, cfg.log);
      const y = this._y(price);
      if (y != null) levels.push({ ...lv, price, y });
    }
    return { cfg, levels, left: cfg.extendLeft ? 0 : Math.min(x1, x2), right: cfg.extendRight ? width : Math.max(x1, x2) };
  }

  _label(ctx, text, x, y, bg, align = 'center') {
    ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
    const lines = String(text).split('\n');
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
    const h = lines.length * 15 + 6;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, y - h / 2, w, h, 4); else ctx.rect(left, y - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((l, k) => ctx.fillText(l, left + 6, y - h / 2 + 3 + 7.5 + k * 15));
  }

  /** Arrow geometry for a symbol whose tip is at (x, y): the label sits beyond the tail. */
  _symbolGeom(d, x, y) {
    const s = clampSize(d.size ?? SYMBOL_SIZE.default);
    const up = d.type === 'arrowUp';
    const dir = up ? 1 : -1;              // the arrow body extends away from the tip: down for ▲, up for ▼
    const gap = Math.max(2, s * 0.2);      // keeps the tip off the candle it points at
    const h = s * 1.8, w = s * 1.4, headH = s * 0.9, shaftW = w * 0.46;
    const tipY = y + (up ? gap : -gap);
    const tailY = tipY + dir * h;
    return { s, up, dir, w, h, headH, shaftW, tipY, tailY, labelY: tailY + dir * 3 };
  }

  _symbolBox(d, x, y) {
    const g = this._symbolGeom(d, x, y);
    const tw = d.text ? (d._w ?? d.text.length * g.s * 0.6) : 0;
    const half = Math.max(g.w / 2, tw / 2);
    const labelH = d.text ? g.s * 1.25 : 0;
    const far = g.labelY + g.dir * labelH;
    return { left: x - half, right: x + half, top: Math.min(g.tipY, far), bottom: Math.max(g.tipY, far) };
  }

  _drawSymbol(ctx, d, x, y) {
    const g = this._symbolGeom(d, x, y);
    const { w, shaftW, headH, tipY, tailY, dir } = g;
    const neck = tipY + dir * headH; // where the head meets the shaft
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    ctx.lineTo(x + w / 2, neck);
    ctx.lineTo(x + shaftW / 2, neck);
    ctx.lineTo(x + shaftW / 2, tailY);
    ctx.lineTo(x - shaftW / 2, tailY);
    ctx.lineTo(x - shaftW / 2, neck);
    ctx.lineTo(x - w / 2, neck);
    ctx.closePath();
    ctx.fill();
    if (!d.text) { d._w = 0; return; }
    ctx.font = `600 ${g.s}px -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = g.up ? 'top' : 'bottom';
    ctx.shadowColor = this.theme.bg;
    ctx.shadowBlur = 4;
    ctx.fillStyle = this.theme.text;
    ctx.fillText(d.text, x, g.labelY);
    d._w = ctx.measureText(d.text).width;
  }

  _drawItem(ctx, d, size, active) {
    const x1 = this._x(d.p1.time), y1 = this._y(d.p1.price);
    const x2 = this._x(d.p2.time), y2 = this._y(d.p2.price);
    if (y1 == null) return;
    ctx.lineWidth = 2;
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    if (STROKE_TOOLS.has(d.type)) { // the line's style and thickness, as set in the drawing's toolbar
      const { width, dash } = strokeOf(d);
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
    }
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
    const line = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };

    switch (d.type) {
      case 'hline': line(0, y1, size.width, y1); break;
      case 'hray': if (x1 != null) line(x1, y1, size.width, y1); break;
      case 'avwap': {
        // The line from the anchor bar to the newest one, drawn only where it's on screen.
        const { from, values } = this._vwap(d);
        if (!values.length) break;
        const ts = this.chart.timeScale();
        const range = ts.getVisibleLogicalRange?.();
        const lo = Math.max(0, Math.floor((range?.from ?? from) - from) - 1);
        const hi = Math.min(values.length - 1, Math.ceil((range?.to ?? from + values.length) - from) + 1);
        ctx.beginPath();
        let started = false, lx = null, ly = null;
        for (let i = lo; i <= hi; i++) {
          const px = ts.logicalToCoordinate(from + i), py = this._y(values[i]);
          if (px == null || py == null) continue;
          if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
          lx = px; ly = py;
        }
        ctx.stroke();
        if (lx != null && d.labels !== false && hi === values.length - 1) {
          this._label(ctx, `${t('draw.avwapShort')} ${this.formatPrice(values[values.length - 1])}`, lx + 6, ly, d.color, 'left');
        }
        break;
      }
      case 'vline': if (x1 != null) line(x1, 0, x1, size.height); break;
      case 'text': {
        if (x1 == null) break;
        ctx.font = '600 14px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor = this.theme.bg;
        ctx.shadowBlur = 4;
        const text = d.text || t('draw.tool.text');
        ctx.fillText(text, x1, y1);
        d._w = ctx.measureText(text).width;
        break;
      }
      case 'arrowUp': case 'arrowDown': if (x1 != null) this._drawSymbol(ctx, d, x1, y1); break;
      default: break;
    }
    if (['hline', 'hray', 'vline', 'text', 'arrowUp', 'arrowDown'].includes(d.type)) {
      this._drawLineLabel(ctx, d, size);
      if (active) for (const [, hx, hy] of this._handles(d)) this._handle(ctx, hx, hy, d.color);
      return;
    }
    if (x1 == null || x2 == null || y2 == null) return;

    switch (d.type) {
      case 'trend': line(x1, y1, x2, y2); break;
      case 'ray': case 'extended': { const [a, b, c, e] = extend(x1, y1, x2, y2, d.type === 'extended'); line(a, b, c, e); break; }
      case 'arrow': {
        line(x1, y1, x2, y2);
        const ang = Math.atan2(y2 - y1, x2 - x1), s = 12;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - s * Math.cos(ang - 0.45), y2 - s * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - s * Math.cos(ang + 0.45), y2 - s * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'rect':
        ctx.fillStyle = rgba(d.color, 0.15);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        break;
      case 'channel': {
        const off = d.p3.price - this._linePriceAt(d.p1, d.p2, d.p3.time);
        const ya = this._y(d.p1.price + off), yb = this._y(d.p2.price + off);
        if (ya == null || yb == null) break;
        ctx.fillStyle = rgba(d.color, 0.12);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x2, yb); ctx.lineTo(x1, ya); ctx.closePath(); ctx.fill();
        line(x1, y1, x2, y2);
        line(x1, ya, x2, yb);
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        line(x1, (y1 + ya) / 2, x2, (y2 + yb) / 2);
        ctx.setLineDash([]);
        break;
      }
      case 'fib': {
        const g = this._fibGeometry(d, size.width);
        if (!g) break;
        const { cfg, left, right } = g;
        let prevY = null;
        for (const lv of g.levels) {
          if (cfg.fill && prevY != null) {
            ctx.fillStyle = rgba(lv.color, 0.1);
            ctx.fillRect(left, Math.min(prevY, lv.y), right - left, Math.abs(lv.y - prevY));
          }
          ctx.strokeStyle = lv.color;
          ctx.lineWidth = 1;
          line(left, lv.y, right, lv.y);
          const text = labelText(cfg, lv.value, this.formatPrice(lv.price));
          if (text) {
            ctx.fillStyle = lv.color;
            ctx.textBaseline = 'middle';
            // Beside the line's start; inside the chart, above the line, when it runs off the left edge.
            if (cfg.extendLeft) { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(text, left + 6, lv.y - 2); }
            else { ctx.textAlign = 'right'; ctx.fillText(text, left - 6, lv.y); }
          }
          prevY = lv.y;
        }
        if (cfg.trend) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = '#8E8A82';
          line(x1, y1, x2, y2);
          ctx.setLineDash([]);
        }
        break;
      }
      case 'measure': {
        const up = d.p2.price >= d.p1.price;
        const col = up ? '#4FA3F7' : '#EC5246';
        ctx.fillStyle = rgba(col, 0.15);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        line(mx, y1, mx, y2);
        line(x1, my, x2, my);
        const dp = d.p2.price - d.p1.price;
        const pct = d.p1.price ? (dp / d.p1.price) * 100 : 0;
        const nb = Math.round(this.logicalFromTime(d.p2.time) - this.logicalFromTime(d.p1.time));
        const secs = Math.abs(d.p2.time - d.p1.time);
        const dur = secs >= 86400 ? t('draw.durD', { n: Math.round(secs / 86400) })
          : secs >= 3600 ? t('draw.durH', { n: Math.round(secs / 3600) }) : t('draw.durM', { n: Math.round(secs / 60) });
        this._label(ctx, `${dp >= 0 ? '+' : ''}${this.formatPrice(dp)} (${pct >= 0 ? '+' : ''}${fixed(pct, 2)}%)\n${t('draw.measure', { n: nb, dur })}`,
          mx, up ? Math.min(y1, y2) - 22 : Math.max(y1, y2) + 22, col);
        break;
      }
      case 'long': case 'short': {
        // While it's being placed there's no stop yet: preview it at 1:1, where it will start.
        const stopPrice = d.p3 ? d.p3.price : d.p1.price - (d.p2.price - d.p1.price);
        const y3 = this._y(stopPrice);
        if (y3 == null) break;
        const left = Math.min(x1, x2), w = Math.abs(x2 - x1);
        ctx.fillStyle = 'rgba(52, 184, 134, 0.2)';
        ctx.fillRect(left, Math.min(y1, y2), w, Math.abs(y2 - y1));
        ctx.fillStyle = 'rgba(236, 82, 70, 0.2)';
        ctx.fillRect(left, Math.min(y1, y3), w, Math.abs(y3 - y1));
        ctx.strokeStyle = '#8E8A82';
        ctx.lineWidth = 1;
        line(left, y1, left + w, y1);
        const entry = d.p1.price, target = d.p2.price, stop = stopPrice;
        const pct = (p) => `${p >= entry ? '+' : ''}${fixed(((p - entry) / entry) * 100, 2)}%`;
        const rr = Math.abs(stop - entry) ? Math.abs(target - entry) / Math.abs(stop - entry) : 0;
        const cx = left + w / 2;
        if (d.labels === false) break; // labels turned off from the drawing's toolbar
        this._label(ctx, t('draw.target', { price: this.formatPrice(target), pct: pct(target) }), cx, y2 + (y2 < y1 ? -14 : 14), '#34B886');
        this._label(ctx, t('draw.stop', { price: this.formatPrice(stop), pct: pct(stop) }), cx, y3 + (y3 < y1 ? -14 : 14), '#EC5246');
        this._label(ctx, t(d.type === 'long' ? 'draw.longRR' : 'draw.shortRR', { rr: fixed(rr, 2) }), cx, y1, '#34373C');
        break;
      }
      default: break;
    }
    this._drawLineLabel(ctx, d, size);
    if (active) for (const [, hx, hy] of this._handles(d)) this._handle(ctx, hx, hy, d.color);
  }

  /** A line's or shape's own label (set in the point editor, issue #6), in its color, beside it. */
  _drawLineLabel(ctx, d, size) {
    if (!d.label || d.labels === false || !LABEL_TOOLS.has(d.type)) return;
    const x1 = this._x(d.p1.time), y1 = this._y(d.p1.price);
    const x2 = this._x(d.p2.time), y2 = this._y(d.p2.price);
    let x, y, align = 'center', base = 'bottom';
    switch (d.type) {
      case 'hline': x = size.width - 8; y = y1 - 4; align = 'right'; break;
      case 'hray': if (x1 == null) return; x = x1 + 8; y = y1 - 4; align = 'left'; break;
      case 'vline': if (x1 == null) return; x = x1 + 6; y = 16; align = 'left'; base = 'top'; break;
      case 'rect': if (x1 == null || x2 == null || y2 == null) return; x = Math.min(x1, x2) + 4; y = Math.min(y1, y2) - 4; align = 'left'; break;
      default: if (x1 == null || x2 == null || y2 == null) return; x = (x1 + x2) / 2; y = (y1 + y2) / 2 - 6; // above the middle of the line
    }
    if (y1 == null || y == null) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = '600 12px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.shadowColor = this.theme.bg;
    ctx.shadowBlur = 4;
    ctx.fillStyle = d.color;
    ctx.fillText(d.label, x, y);
    ctx.restore();
  }

  _handle(ctx, x, y, color) {
    ctx.setLineDash([]); // a dashed or dotted line's handles are still solid circles
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = this.theme.bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}
