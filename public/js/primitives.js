// Custom canvas pieces drawn through the chart library's plugin interface.

import { t } from './i18n.js';

const DAY = 86400;

/**
 * Shades the area between two value arrays (e.g. Bollinger upper/lower, Ichimoku cloud).
 * getArrays() returns { a, b } aligned with the chart's bars (logical index = bar index).
 * fill: { color } or { colors: [whenAAboveB, whenBAboveA] }.
 */
export class BandFill {
  constructor(getArrays, fill) {
    this.getArrays = getArrays;
    this.fill = fill;
    this.chart = null;
    this.series = null;
    this.hidden = false;
    this._request = null;
    this._views = [{ zOrder: () => 'bottom', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this._request = requestUpdate; }
  detached() { this.chart = null; this.series = null; this._request = null; }
  updateAllViews() {}
  paneViews() { return this._views; }

  /** Hidden bands draw nothing (the indicator's eye button); the chart redraws right away. */
  setHidden(on) { this.hidden = on; this._request?.(); }

  draw(target) {
    const arrays = this.hidden ? null : this.getArrays();
    if (!arrays || !this.series || !this.chart) return;
    const { a, b } = arrays;
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range || !a?.length) return;
    const from = Math.max(0, Math.floor(range.from) - 1);
    const to = Math.min(a.length - 1, Math.ceil(range.to) + 1);
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      let run = [], runColor = null;
      const flush = () => {
        if (run.length > 1) {
          ctx.beginPath();
          run.forEach(([x, ya], k) => (k ? ctx.lineTo(x, ya) : ctx.moveTo(x, ya)));
          for (let k = run.length - 1; k >= 0; k--) ctx.lineTo(run[k][0], run[k][2]);
          ctx.closePath();
          ctx.fillStyle = runColor;
          ctx.fill();
        }
        run = [];
      };
      for (let i = from; i <= to; i++) {
        const va = a[i], vb = b[i];
        if (!Number.isFinite(va) || !Number.isFinite(vb)) { flush(); runColor = null; continue; }
        const x = ts.logicalToCoordinate(i);
        const ya = this.series.priceToCoordinate(va), yb = this.series.priceToCoordinate(vb);
        if (x == null || ya == null || yb == null) { flush(); continue; }
        const color = this.fill.colors ? (va >= vb ? this.fill.colors[0] : this.fill.colors[1]) : this.fill.color;
        if (runColor && color !== runColor) {
          const last = run[run.length - 1];
          flush();
          if (last) run.push(last); // keep the band continuous where the colour switches
        }
        runColor = color;
        run.push([x, ya, yb]);
      }
      flush();
    });
  }
}

/**
 * Dashed lines from each backtest trade's entry to its exit (green for wins, red for losses).
 * getData() returns { trades: [{ ei, ep, xi, xp, win }] } with bar indexes and prices.
 */
export class TradeLines {
  constructor(getData) {
    this.getData = getData;
    this.chart = null;
    this.series = null;
    this.hidden = false;
    this._request = null;
    this._views = [{ zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this._request = requestUpdate; }
  detached() { this.chart = null; this.series = null; this._request = null; }
  updateAllViews() {}
  paneViews() { return this._views; }

  setHidden(on) { this.hidden = on; this._request?.(); }

  draw(target) {
    const data = this.hidden ? null : this.getData();
    if (!data || !this.chart || !this.series) return;
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const t of data.trades) {
        if (t.xi < range.from - 1 || t.ei > range.to + 1) continue;
        const x1 = ts.logicalToCoordinate(t.ei), x2 = ts.logicalToCoordinate(t.xi);
        const y1 = this.series.priceToCoordinate(t.ep), y2 = this.series.priceToCoordinate(t.xp);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        ctx.strokeStyle = t.win ? 'rgba(52, 184, 134, 0.85)' : 'rgba(236, 82, 70, 0.85)';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
  }
}

function fmtRemaining(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / DAY), h = Math.floor((s % DAY) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (d > 0) return t('chart.countdownDays', { d, h });
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** Time left until the current bar closes, shown under the last-price label (like most trading terminals). */
export class Countdown {
  constructor(view, colors) {
    this.view = view;
    this.colors = colors; // { up, down }
    this.series = null;
    this.request = null;
    this.text = '';
    this.visible = false;
    this.color = colors.up;
    this.timer = null;
    this._axis = [{
      coordinate: () => this.y(),
      text: () => this.text,
      textColor: () => '#FFFFFF',
      backColor: () => this.color,
      visible: () => this.visible,
      tickVisible: () => false,
    }];
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.request = requestUpdate;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  detached() {
    clearInterval(this.timer);
    this.series = null;
    this.request = null;
  }

  updateAllViews() {}
  priceAxisViews() { return this._axis; }

  tick() {
    const v = this.view;
    const last = v.lastBar;
    const tf = v.tf;
    // Stock daily bars end at the session close, not midnight, so only count down where that holds.
    const show = !!(last && v.feed && (!tf.daily || v.isCrypto));
    let remaining = -1;
    if (show) {
      let end = last.time + tf.sec;
      if (tf.id === '1M') {
        const d = new Date(last.time * 1000);
        end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
      }
      remaining = end - (Date.now() / 1000 + (v.meta.tzOffset || 0));
    }
    const visible = show && remaining > 0 && remaining <= tf.sec + 60;
    const text = visible ? fmtRemaining(remaining) : '';
    const color = last && last.close >= last.open ? this.colors.up : this.colors.down;
    if (visible !== this.visible || text !== this.text || color !== this.color) {
      this.visible = visible;
      this.text = text;
      this.color = color;
      this.request?.();
    }
  }

  y() {
    const last = this.view.lastBar;
    const c = last && this.series ? this.series.priceToCoordinate(this.view.mainValueAt(this.view.bars.length - 1)) : null;
    return c == null ? -100 : c + 17;
  }
}
