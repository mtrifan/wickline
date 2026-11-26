// Options panel: the option chain of the active chart's symbol, from the server's /api/options
// (lib/options.mjs): US stocks and ETFs from Yahoo (~15 minutes delayed), Bitcoin and Ether from
// Deribit (real time). Shows one expiry at a time: statistics (ATM IV, expected move, put/call
// ratios, max pain), the chain (calls | strike | puts, centred on the price), open interest by
// strike and unusual activity. Clicking a Yahoo contract opens its chart on the active chart.
// The formatting helpers are pure and unit-tested in test/options.test.mjs.

import { apiUrl, dataMode } from './env.js';
import { $, esc, numberFormat, store, fixed } from './util.js';
import { t, locale } from './i18n.js';

const CONTRACT = /^YAHOO:([A-Z][A-Z0-9.]{0,6}?)(\d{6})([CP])(\d{8})$/;
// Option roots that aren't the underlying's ticker: index options (weeklies too) and share classes.
const ROOTS = {
  SPX: '^SPX', SPXW: '^SPX', NDX: '^NDX', NDXP: '^NDX', VIX: '^VIX', VIXW: '^VIX', RUT: '^RUT', RUTW: '^RUT',
  XSP: '^XSP', BRKB: 'BRK-B', BFB: 'BF-B',
};

/** The symbol whose options to show: an option contract's chart → its underlying ("YAHOO:SPY261204C00690000" → "YAHOO:SPY", "YAHOO:SPXW…" → "YAHOO:^SPX"). */
export function optionsUnderlying(full) {
  const m = CONTRACT.exec(full || '');
  return m ? `YAHOO:${ROOTS[m[1]] || m[1]}` : full || '';
}

/** Whole days until an expiry (at: unix seconds), 0 on its last day. */
export const daysLeft = (at, now = Date.now()) => Math.max(0, Math.floor((at * 1000 - now) / 86400000));

/** "8h" or "11d" until an expiry. */
export function timeLeft(at, now = Date.now()) {
  const h = (at * 1000 - now) / 3600000;
  if (h <= 0) return t('opt.expired');
  return h < 24 ? t('opt.hours', { n: Math.max(1, Math.round(h)) }) : t('opt.days', { n: daysLeft(at, now) });
}

const ICON_DOWN = '<svg class="op-exp-caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DAY_S = 86400;
const utcDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Whether an expiry is a monthly, a weekly or (Deribit only) a daily, in each venue's own terms.
 * Stocks: the monthly is the month's third Friday and every other expiry is a weekly (exchanges list
 * SPY's Monday and Wednesday expiries as Weeklys too). Deribit: the monthly is the month's last Friday,
 * other Fridays are weeklies, other days dailies. When a Friday is a market holiday the expiry moves to
 * the Thursday before, so a Thursday whose Friday isn't listed counts as that Friday.
 */
export function expiryKind(e, expiries = [], source = 'yahoo') {
  let d = new Date(e.t * 1000);
  if (d.getUTCDay() === 4) {
    const fri = utcDay(e.t + DAY_S);
    if (!expiries.some((x) => utcDay(x.t) === fri)) d = new Date((e.t + DAY_S) * 1000);
  }
  if (d.getUTCDay() !== 5) return source === 'deribit' ? 'daily' : 'weekly';
  const day = d.getUTCDate();
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const monthly = source === 'deribit' ? day + 7 > monthEnd : day >= 15 && day <= 21;
  return monthly ? 'monthly' : 'weekly';
}

/** An expiry for the menu: "Fri, Dec 4 · 11d" ("Dec 17, 2027 · 389d" in another year), plus "· Monthly" etc. when kind is given. */
export function expiryLabel(e, now = Date.now(), kind = null) {
  const d = new Date(e.t * 1000);
  const other = d.getUTCFullYear() !== new Date(now).getUTCFullYear();
  const date = d.toLocaleDateString(locale, { timeZone: 'UTC', weekday: other ? undefined : 'short', month: 'short', day: 'numeric', year: other ? 'numeric' : undefined });
  return `${date} · ${timeLeft(e.at, now)}${kind ? ` · ${t(`opt.kind.${kind}`)}` : ''}`;
}

/** The expiry button: "Fri, Dec 18 · 24d" with an M / W / D badge. */
export function expiryButton(d, now = Date.now()) {
  const e = d.expiries.find((x) => x.t === d.expiry) || d.expiries[0];
  if (!e) return '';
  const kind = expiryKind(e, d.expiries, d.source);
  return `<span>${esc(expiryLabel(e, now))}</span><i class="op-kind op-${kind}" title="${esc(t(`opt.kind.${kind}`))}">${esc(t(`opt.kind.short.${kind}`))}</i>`;
}

/**
 * The expiry menu: the expiries under their month ("December", "January 2027"), each row "Fri 18 · M · 24d",
 * and a key at the bottom ("M Monthly · W Weekly"). Monthlies stand out, dailies step back, the picked one is marked.
 */
export function expiryMenu(d, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const kinds = new Set();
  let month = '';
  const rows = d.expiries.map((e) => {
    const dt = new Date(e.t * 1000);
    const kind = expiryKind(e, d.expiries, d.source);
    kinds.add(kind);
    const m = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}`;
    let head = '';
    if (m !== month) {
      month = m;
      head = `<div class="menu-title">${esc(dt.toLocaleDateString(locale, { timeZone: 'UTC', month: 'long', year: dt.getUTCFullYear() !== year ? 'numeric' : undefined }))}</div>`;
    }
    const on = e.t === d.expiry;
    const day = `${dt.toLocaleDateString(locale, { timeZone: 'UTC', weekday: 'short' })} ${dt.getUTCDate()}`;
    return `${head}<button class="op-exp-row op-${kind}${on ? ' on' : ''}" role="option" aria-selected="${on}" data-exp="${e.t}" title="${esc(expiryLabel(e, now, kind))}">`
      + `<span>${esc(day)}</span><i class="op-kind op-${kind}">${esc(t(`opt.kind.short.${kind}`))}</i><small>${esc(timeLeft(e.at, now))}</small></button>`;
  }).join('');
  const key = ['monthly', 'weekly', 'daily'].filter((k) => kinds.has(k))
    .map((k) => `<span><i class="op-kind op-${k}">${esc(t(`opt.kind.short.${k}`))}</i>${esc(t(`opt.kind.${k}`))}</span>`).join('');
  return `${rows}<div class="op-exp-key">${key}</div>`;
}

/** A price: "1.25", "0.07", "23,397" (no cents from 10,000, or from 1,000 when compact). */
export function fmtPrice(v, compact = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = Math.abs(v) >= (compact ? 1000 : 10000) ? 0 : 2;
  return numberFormat(d, d).format(v);
}

/** A count of contracts: "12,345", "104.7" (Deribit trades fractions of a coin). */
export function fmtCount(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return numberFormat(undefined, Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 1).format(v);
}

/** A strike: "690", "342.5", "61,500". */
export const fmtStrike = (v) => (v == null ? '—' : typeof v === 'number' ? numberFormat(undefined, 2).format(v) : v.toLocaleString(locale, { maximumFractionDigits: 2 }));
/** A volatility: 0.2531 → "25.3%". */
export const fmtIv = (v) => (v == null || !Number.isFinite(v) ? '—' : `${fixed(v * 100, 1)}%`);
const fmtPct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), d)}%`);
const fmtGreek = (v, d) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${fixed(Math.abs(v), d)}`);
const fmtRatio = (v) => (v == null || !Number.isFinite(v) ? '—' : fixed(v, 2));
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/**
 * The strikes the open-interest chart shows: up to `max` around the at-the-money strike (indexes
 * into rows), widened to take in max pain when it's close, without empty strikes at the ends.
 */
export function oiWindow(rows, spot, maxPainStrike = null, max = 60) {
  if (!rows.length) return [0, 0];
  let atm = 0;
  rows.forEach((r, i) => { if (Math.abs(r.strike - spot) < Math.abs(rows[atm].strike - spot)) atm = i; });
  let lo = Math.max(0, atm - (max >> 1)), hi = Math.min(rows.length, lo + max);
  lo = Math.max(0, hi - max);
  const mp = maxPainStrike == null ? -1 : rows.findIndex((r) => r.strike === maxPainStrike);
  if (mp >= 0 && mp < lo && lo - mp <= max / 2) lo = mp;
  if (mp >= hi && mp - hi < max / 2) hi = mp + 1;
  const oi = (r) => (r.call?.oi || 0) + (r.put?.oi || 0);
  while (hi - lo > 1 && !oi(rows[lo]) && lo !== mp) lo++;
  while (hi - lo > 1 && !oi(rows[hi - 1]) && hi - 1 !== mp) hi--;
  return [lo, hi];
}

const SIDE_COLS = ['last', 'bid', 'ask', 'volume', 'oi', 'iv', 'delta'];
const COL_NAMES = { last: t('common.last'), bid: t('opt.col.bid'), ask: t('opt.col.ask'), volume: t('opt.col.vol'), oi: t('opt.col.oi'), iv: 'IV', delta: t('opt.delta') };
const COL_TIPS = { last: t('opt.lastTrade'), volume: t('opt.col.volTip'), oi: t('opt.col.oiTip'), iv: t('opt.col.ivTip'), delta: t('opt.col.deltaTip') };
const cell = (c, k) => {
  if (!c) return '';
  const v = c[k];
  if (k === 'volume' || k === 'oi') return fmtCount(v);
  if (k === 'iv') return fmtIv(v);
  if (k === 'delta') return fmtGreek(v, 2);
  return fmtPrice(v, true);
};

export class OptionsPanel {
  constructor({ onPick, getActiveSymbol }) {
    this.onPick = onPick;
    this.getActiveSymbol = getActiveSymbol;
    this.el = $('#options');
    this.body = $('#op-body');
    this.symbol = '';
    this.expiry = null; // the expiry picked in the menu; null: the nearest (the server's choice)
    this.picked = new Map(); // contract chart opened from here → the chain it came from
    this.data = null;
    this.error = null;
    this.gen = 0;
    this.timer = null;
    this.shownKey = ''; // symbol|expiry last drawn, to scroll to the price only when it changes
    this.tip = document.createElement('div');
    this.tip.className = 'hm-tip op-tip';
    this.tip.hidden = true;
    document.body.append(this.tip);

    this.el.querySelector('#op-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.menu = document.createElement('div');
    this.menu.className = 'menu op-exp-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.hidden = true;
    document.body.append(this.menu);
    this.menu.addEventListener('click', (e) => {
      const row = e.target.closest('.op-exp-row');
      if (row) this.pickExpiry(Number(row.dataset.exp));
    });
    this.menu.addEventListener('keydown', (e) => this.onMenuKey(e));
    this.el.querySelector('#op-tools').addEventListener('keydown', (e) => {
      if (!e.target.closest('.op-exp-btn') || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation(); // not the chart's arrow-key shortcuts
      this.openMenu();
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target) && !e.target.closest('.op-exp-btn')) this.closeMenu();
    });
    window.addEventListener('resize', () => this.closeMenu());
    this.body.addEventListener('mouseover', (e) => this.onHover(e));
    this.body.addEventListener('mousemove', (e) => { if (e.target.tagName === 'CANVAS') this.onChartHover(e); });
    this.body.addEventListener('mouseleave', () => { this.tip.hidden = true; });
    new ResizeObserver(() => { if (this.isOpen) this.drawOi(); }).observe(this.body);
    // Redraw the chart in the new colors when the theme changes.
    new MutationObserver(() => { if (this.isOpen) this.drawOi(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // One update per frame; the height is saved once, when the drag ends.
      let y = e.clientY, frame = 0, moved = false;
      const apply = () => { frame = 0; this.setHeight(window.innerHeight - y - 28, false); };
      const move = (ev) => { y = ev.clientY; moved = true; if (!frame) frame = requestAnimationFrame(apply); };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        cancelAnimationFrame(frame);
        if (moved) {
          if (ev.type === 'pointerup') y = ev.clientY;
          this.setHeight(window.innerHeight - y - 28);
        }
        window.dispatchEvent(new Event('resize'));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    this.setHeight(store.get('optionsHeight', 440), false);
    // Nothing is fetched or drawn while the window is hidden; catch up when it's shown again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isOpen && this.stalled) this.load();
    });
  }

  get isOpen() { return !this.el.hidden; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(260, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('optionsHeight', height);
  }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('options-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      $('#op-tools').innerHTML = '';
      $('#op-src').textContent = '';
      this.body.innerHTML = `<div class="st-empty"><b>${esc(t('opt.desktop'))}</b>
        <span>${t('opt.desktopHelp')}</span></div>`;
      return;
    }
    const sym = this.underlyingOf(this.getActiveSymbol?.());
    if (sym !== this.symbol) this.setSymbol(sym);
    else { if (!this.data) this.showLoading(); this.load(); }
  }

  /**
   * The chain to show for a chart: a contract opened from this panel (or one in the chain shown)
   * keeps that chain, since a contract's root isn't always its underlying's ticker (SPXW → ^SPX).
   */
  underlyingOf(full) {
    if (!full) return '';
    if (this.picked.has(full)) return this.picked.get(full);
    const ticker = full.replace(/^YAHOO:/, '');
    if (this.symbol && ticker !== full && this.data?.rows?.some((r) => r.call?.symbol === ticker || r.put?.symbol === ticker)) return this.symbol;
    return optionsUnderlying(full);
  }

  /** Opens a contract's chart, remembering which chain it belongs to. */
  pick(contract) {
    const full = `YAHOO:${contract}`;
    this.picked.delete(full);
    this.picked.set(full, this.symbol);
    if (this.picked.size > 200) this.picked.delete(this.picked.keys().next().value);
    this.onPick(full);
  }

  close() {
    this.closeMenu();
    this.el.hidden = true;
    this.tip.hidden = true;
    document.body.classList.remove('options-open');
    clearTimeout(this.timer);
    this.gen++;
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  /** Called when the active chart changes: show its options (a contract's chart keeps its underlying's). */
  syncSymbol() {
    if (!this.isOpen || !this.symbol) return;
    const sym = this.underlyingOf(this.getActiveSymbol?.());
    if (sym && sym !== this.symbol) this.setSymbol(sym);
  }

  setSymbol(sym) {
    this.symbol = sym;
    this.expiry = null;
    this.data = null;
    this.error = null;
    this.tip.hidden = true;
    this.clearTools(); // the last symbol's expiries (a Yahoo date means nothing to Deribit)
    this.showLoading();
    this.load();
  }

  clearTools() {
    this.closeMenu();
    $('#op-tools').innerHTML = '';
    $('#op-src').textContent = '';
    this.toolsKey = '';
  }

  showLoading() {
    $('#op-symbol').textContent = this.symbol.replace(/^[A-Z]+:/, '');
    this.body.innerHTML = `<div class="st-empty"><b>${esc(t('opt.loading'))}</b><span>${esc(t('opt.loadingHelp'))}</span></div>`;
  }

  showError(msg, retry = true) {
    this.clearTools();
    this.body.innerHTML = `<div class="st-empty"><b>${esc(t('opt.loadFailed'))}</b><span>${esc(msg)}</span>
      ${retry ? `<button type="button" class="btn-ghost op-retry" data-op-retry="1">${esc(t('opt.tryAgain'))}</button>` : ''}</div>`;
  }

  async load() {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    const symbol = this.symbol;
    if (!symbol) { this.body.innerHTML = `<div class="st-empty"><b>${esc(t('opt.noChart'))}</b></div>`; return; }
    // Hidden (minimised or covered): no fetching or drawing until visibilitychange says it's back.
    this.stalled = document.hidden;
    if (this.stalled) return;
    let every = 60000;
    try {
      const q = new URLSearchParams({ symbol });
      if (this.expiry != null) q.set('expiry', String(this.expiry));
      const r = await fetch(apiUrl(`api/options?${q}`));
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: r.status });
      if (gen !== this.gen) return;
      if (document.hidden) { this.stalled = true; return; } // hidden meanwhile: draw it when shown
      this.error = null;
      if (j.none) {
        this.data = null;
        this.renderNone(j.none);
        return; // nothing to refresh
      }
      if (!Array.isArray(j.rows)) throw new Error(t('opt.badAnswer'));
      // this.expiry stays what was picked (or null): the server moves past an expiry once it has
      // expired, which pinning the one it chose would stop.
      this.data = j;
      if (j.source === 'deribit') every = 15000;
      // The server's copy hasn't changed since the last draw (it refetches once a minute, Deribit
      // every 15 s): keep the table and only refresh the footer (which clears an earlier error).
      if (this.drawnKey === this.dataKey(j) && this.body.querySelector('.op-chain')) this.renderFoot();
      else this.render();
    } catch (e) {
      if (gen !== this.gen) return;
      this.error = e.message || String(e);
      // A request the server refuses (a symbol it can't take, 4xx) won't work on a retry.
      const refused = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
      if (!this.data) this.showError(this.error, !refused);
      else this.renderFoot(); // keep the chain; the footer says the update failed
      if (refused) return;
      every = 30000;
    }
    if (this.isOpen && gen === this.gen) this.timer = setTimeout(() => this.load(), every);
  }

  renderNone(msg) {
    this.clearTools();
    $('#op-symbol').textContent = this.symbol.replace(/^[A-Z]+:/, '');
    this.body.innerHTML = `<div class="st-empty op-none"><b>${esc(t('opt.none', { symbol: this.symbol.replace(/^[A-Z]+:/, '') }))}</b><span>${esc(msg)}</span></div>`;
  }

  openMenu() {
    const btn = this.el.querySelector('.op-exp-btn');
    if (!btn || !this.data) return;
    this.menu.innerHTML = expiryMenu(this.data);
    this.menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 260 && above > below; // the panel sits low on the screen: open upwards if there's more room
    this.menu.style.maxHeight = `${Math.min(440, up ? above : below)}px`;
    this.menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - this.menu.offsetWidth - 8))}px`;
    this.menu.style.top = up ? `${r.top - 4 - this.menu.offsetHeight}px` : `${r.bottom + 4}px`;
    const on = this.menu.querySelector('.op-exp-row.on') || this.menu.querySelector('.op-exp-row');
    if (on) {
      this.menu.scrollTop = on.offsetTop - (this.menu.clientHeight - on.offsetHeight) / 2;
      on.focus({ preventScroll: true });
    }
  }

  closeMenu(refocus = false) {
    if (!this.menu || this.menu.hidden) return;
    this.menu.hidden = true;
    const btn = this.el.querySelector('.op-exp-btn');
    btn?.setAttribute('aria-expanded', 'false');
    if (refocus) btn?.focus();
  }

  /** Up/Down move through the expiries, Enter picks one, Esc closes. */
  onMenuKey(e) {
    e.stopPropagation(); // the chart's shortcuts don't apply in here
    const rows = [...this.menu.querySelectorAll('.op-exp-row')];
    const i = rows.indexOf(document.activeElement);
    const go = (j) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && rows[i]) { e.preventDefault(); this.pickExpiry(Number(rows[i].dataset.exp)); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); this.closeMenu(true); }
  }

  /** An expiry was picked from the menu: show it on the button at once, then load its chain. */
  pickExpiry(at) {
    this.closeMenu(true);
    if (!this.data || at === this.data.expiry) return;
    this.expiry = at;
    this.tip.hidden = true;
    const btn = this.el.querySelector('.op-exp-btn');
    if (btn) { btn.innerHTML = expiryButton({ ...this.data, expiry: at }) + ICON_DOWN; btn.dataset.exp = at; }
    this.load();
  }

  onClick(e) {
    if (e.target.closest('[data-op-retry]')) { this.showLoading(); this.load(); return; }
    if (e.target.closest('.op-exp-btn')) { if (this.menu.hidden) this.openMenu(); else this.closeMenu(); return; }
    const pick = e.target.closest('[data-op-chart]');
    if (pick) { this.pick(pick.dataset.opChart); return; }
    const td = e.target.closest('td[data-side]');
    if (!td || this.data?.source !== 'yahoo') return;
    const row = this.data.rows[Number(td.closest('tr').dataset.i)];
    const c = td.dataset.side === 'c' ? row?.call : row?.put;
    if (c?.symbol) this.pick(c.symbol);
  }

  /** What a drawn chain depends on: the same symbol, expiry, server copy and strikes draw the same. */
  dataKey(d) { return `${this.symbol}|${d.symbol}|${d.expiry}|${d.updated}|${d.rows.length}`; }

  render() {
    const d = this.data;
    this.drawnKey = this.dataKey(d);
    const u = d.underlying;
    const st = d.stats;
    const now = Date.now();
    $('#op-symbol').textContent = u.symbol;
    const toolsKey = [this.symbol, d.expiry, ...d.expiries.map((e) => `${e.t}:${timeLeft(e.at, now)}`)].join('|');
    if (toolsKey !== this.toolsKey || !$('#op-tools .op-exp-btn')) {
      const hadFocus = document.activeElement?.closest?.('.op-exp-btn');
      this.toolsKey = toolsKey;
      $('#op-tools').innerHTML = `<button class="select op-exp-btn" data-exp="${d.expiry}" aria-haspopup="listbox" aria-expanded="${!this.menu.hidden}" aria-label="${esc(t('opt.expiry'))}" title="${esc(t('opt.expiryTip'))}">${expiryButton(d, now)}${ICON_DOWN}</button>
        <span class="muted op-count">${esc(t('opt.expiries', { n: d.expiries.length }))}</span>`;
      if (!this.menu.hidden) this.menu.innerHTML = expiryMenu(d, now); // it's open while the data updated
      if (hadFocus) $('#op-tools .op-exp-btn').focus(); // redrawn: keep the keyboard where it was
    }
    const src = $('#op-src');
    src.className = `op-src ${d.delayed ? 'muted' : 'op-live'}`;
    src.innerHTML = d.delayed ? esc(t('opt.src.delayed')) : `<i></i>${esc(t('opt.src.live'))}`;

    const sp = st.spot;
    const fromSpot = (k) => (k != null && sp ? fmtPct(((k - sp) / sp) * 100) : '');
    const kpi = (label, value, small = '', tip = '', klass = '') => `<div class="st-kpi"${tip ? ` title="${esc(tip)}"` : ''}><span>${esc(label)}</span><b class="${klass}">${value}</b><small>${small}</small></div>`;
    const kpis = [
      kpi(u.name || u.symbol, fmtPrice(u.price), u.change != null ? t('opt.today', { change: `<span class="${cls(u.change)}">${fmtPct(u.change)}</span>` })
        : d.source === 'deribit' ? esc(t('opt.indexForward', { price: fmtPrice(u.forward) })) : '',
        d.source === 'deribit' ? t('opt.indexTip') : t('opt.lastTip', { symbol: u.symbol })),
      kpi(t('opt.expiry'), esc(new Date(d.expiry * 1000).toLocaleDateString(locale, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })),
        esc(t('opt.left', { time: timeLeft(d.expiresAt, now) })), t('opt.expiresTip', { time: new Date(d.expiresAt * 1000).toLocaleString(locale) })),
      kpi(t('opt.atmIv'), fmtIv(st.atmIv), st.atmStrike != null ? esc(t('opt.strikeAt', { strike: fmtStrike(st.atmStrike) })) : '', t('opt.atmIvTip')),
      kpi(t('opt.expectedMove'), st.straddle != null ? `±${fmtPrice(st.straddle)}` : '—',
        esc(st.straddlePct != null ? t('opt.straddlePct', { pct: fixed(st.straddlePct, 2) }) : t('opt.straddle')), t('opt.expectedMoveTip')),
      kpi(t('opt.sigma'), st.sigmaMove != null ? `±${fmtPrice(st.sigmaMove)}` : '—',
        esc(st.sigmaPct != null ? t('opt.fromIvPct', { pct: fixed(st.sigmaPct, 2) }) : t('opt.fromIv')), t('opt.sigmaTip')),
      kpi(t('opt.pc'), fmtRatio(st.pcVolume), esc(t('opt.pcSmall', { ratio: fmtRatio(st.pcOi) })),
        t('opt.pcTip', { putVol: fmtCount(st.putVolume), callVol: fmtCount(st.callVolume), putOi: fmtCount(st.putOi), callOi: fmtCount(st.callOi) }),
        st.pcVolume > 1 ? 'down' : st.pcVolume != null && st.pcVolume < 0.7 ? 'up' : ''),
      kpi(t('opt.maxPain'), st.maxPain != null ? fmtStrike(st.maxPain) : '—',
        esc(st.maxPain != null ? t('opt.fromPrice', { pct: fromSpot(st.maxPain) }) : st.oiMissing ? t('opt.noOiYet') : ''), t('opt.maxPainTip')),
    ];

    // The chain: calls | strike | puts, with a line where the price is.
    const th = (k) => `<th${COL_TIPS[k] ? ` title="${esc(COL_TIPS[k])}"` : ''}>${esc(COL_NAMES[k])}</th>`;
    const head = `<thead><tr class="op-grp"><th colspan="${SIDE_COLS.length}" class="op-calls">${esc(t('opt.calls'))}</th><th></th><th colspan="${SIDE_COLS.length}" class="op-puts">${esc(t('opt.puts'))}</th></tr>
      <tr>${SIDE_COLS.map(th).join('')}<th class="op-k">${esc(t('opt.strike'))}</th>${[...SIDE_COLS].reverse().map(th).join('')}</tr></thead>`;
    const html = [];
    let spotDone = false;
    const spotRow = `<tr class="op-spot"><td colspan="${SIDE_COLS.length * 2 + 1}"><span>${esc(u.symbol)} ${fmtPrice(sp)}</span></td></tr>`;
    const clickable = d.source === 'yahoo';
    d.rows.forEach((r, i) => {
      if (!spotDone && sp != null && r.strike >= sp) { html.push(spotRow); spotDone = true; }
      const side = (c, s) => (c ? (s === 'c' ? SIDE_COLS : [...SIDE_COLS].reverse()).map((k) =>
        `<td data-side="${s}" class="${c.itm ? 'itm' : ''}${k === 'delta' || k === 'iv' ? ' op-g' : ''}">${cell(c, k)}</td>`).join('')
        : `<td class="op-empty" colspan="${SIDE_COLS.length}"></td>`);
      html.push(`<tr data-i="${i}"${r.strike === st.atmStrike ? ' class="op-atm"' : ''}>${side(r.call, 'c')}<td class="op-k">${fmtStrike(r.strike)}</td>${side(r.put, 'p')}</tr>`);
    });
    if (!spotDone && sp != null) html.push(spotRow);

    const key = `${this.symbol}|${d.expiry}`;
    const wrap = this.body.querySelector('.op-chain');
    const keep = key === this.shownKey && wrap ? wrap.scrollTop : null;
    this.body.innerHTML = `
      <div class="st-kpis op-kpis">${kpis.join('')}</div>
      <div class="op-main">
        <div class="op-chain${clickable ? ' clickable' : ''}" tabindex="0"><table class="op-table">${head}<tbody>${html.join('')}</tbody></table></div>
        <aside class="op-side">
          <div class="op-box op-oi">
            <div class="op-h"><b>${esc(t('opt.oiByStrike'))}</b><span class="op-key"><i class="up"></i>${esc(t('opt.calls'))} <i class="down"></i>${esc(t('opt.puts'))} <i class="op-mp"></i>${esc(t('opt.maxPain'))}</span></div>
            <div class="op-canvas"><canvas aria-label="${esc(t('opt.oiByStrike'))}"></canvas></div>
          </div>
          <div class="op-box op-ua">
            <div class="op-h"><b>${esc(t('opt.unusual'))}</b><span class="muted" title="${esc(t('opt.unusualTip'))}">${esc(t('opt.unusualKey'))}</span></div>
            <div class="op-ua-list">${this.unusualHtml()}</div>
          </div>
        </aside>
      </div>
      <div class="op-foot"></div>`;
    this.renderFoot();
    this.drawOi();
    const chain = this.body.querySelector('.op-chain');
    if (keep != null) chain.scrollTop = keep;
    else {
      // Centre the price line.
      const line = chain.querySelector('.op-spot');
      if (line) chain.scrollTop = Math.max(0, line.offsetTop - chain.clientHeight / 2);
    }
    this.shownKey = key;
  }

  unusualHtml() {
    const d = this.data;
    if (d.stats.oiMissing) {
      return `<div class="op-note">${esc(d.source === 'yahoo' ? t('opt.noOiYahoo') : t('opt.noOiExpiry'))}</div>`;
    }
    if (!d.unusual.length) return `<div class="op-note">${esc(t('opt.nothingUnusual'))}</div>`;
    const unit = d.source === 'deribit' ? ` ${esc(d.unit)}` : '';
    return d.unusual.map((x) => {
      const chart = d.source === 'yahoo' ? ` data-op-chart="${esc(x.symbol)}" title="${esc(t('opt.openChart', { symbol: x.symbol }))}"` : ` title="${esc(x.symbol)}"`;
      return `<button type="button" class="op-ua-row${d.source === 'yahoo' ? '' : ' static'}"${chart}>
        <b class="op-cp ${x.type === 'C' ? 'up' : 'down'}">${esc(x.type === 'C' ? t('opt.call') : t('opt.put'))}</b>
        <span class="op-ua-k">${fmtStrike(x.strike)}</span>
        <span class="muted">${t('opt.uaLine', { vol: fmtCount(x.volume), unit, oi: fmtCount(x.oi) })}</span>
        <b class="op-ua-x">${x.ratio != null ? `${x.ratio >= 10 ? Math.round(x.ratio) : fixed(x.ratio, 1)}×` : esc(t('opt.new'))}</b>
      </button>`;
    }).join('');
  }

  renderFoot() {
    const foot = this.body.querySelector('.op-foot');
    const d = this.data;
    if (!foot || !d) return;
    const notes = [];
    if (d.source === 'yahoo' && !d.stats.quoted) notes.push(t('opt.note.noQuotes'));
    notes.push(d.source === 'deribit' ? t('opt.note.greeksForward') : t('opt.note.greeksRate', { rate: (d.rate * 100).toLocaleString(locale, { maximumFractionDigits: 2 }) }));
    notes.push(d.source === 'deribit' ? t('opt.note.perUnit', { unit: d.unit }) : t('opt.note.perShare'));
    if (d.source === 'yahoo') notes.push(t('opt.note.click'));
    const time = new Date(d.updated).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    foot.innerHTML = `<span>${notes.map(esc).join(' · ')}</span><span class="spacer"></span>
      <span class="${this.error ? 'down' : ''}">${esc(this.error ? t('opt.updateFailed', { error: this.error, time }) : t('opt.updated', { time }))}</span>`;
  }

  /** Open interest by strike: calls up, puts down, the price and max pain marked. */
  drawOi() {
    const d = this.data;
    const cv = this.body.querySelector('.op-oi canvas');
    if (!d || !cv) return;
    const box = cv.parentElement;
    const w = box.clientWidth, h = box.clientHeight;
    if (w < 40 || h < 40) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const color = (n, f) => css.getPropertyValue(n).trim() || f;
    const up = color('--up', '#2EBD85'), down = color('--down', '#F6465D'), muted = color('--muted', '#888'), text = color('--text', '#ddd'), border = color('--border', '#333');
    const MP = '#F7A600';
    g.font = '11px ' + (css.getPropertyValue('--font') || 'sans-serif');
    if (d.stats.oiMissing) {
      g.fillStyle = muted; g.textAlign = 'center';
      g.fillText(t('opt.noOiNow'), w / 2, h / 2);
      this.oiLayout = null;
      return;
    }
    const [lo, hi] = oiWindow(d.rows, d.stats.spot, d.stats.maxPain);
    const rows = d.rows.slice(lo, hi);
    const max = Math.max(1, ...rows.map((r) => Math.max(r.call?.oi || 0, r.put?.oi || 0)));
    const left = 4, right = w - 4, top = 16, bottom = h - 18; // labels above, strikes below
    const mid = (top + bottom) / 2, half = (bottom - top) / 2;
    const step = (right - left) / Math.max(1, rows.length);
    const bw = Math.max(1, step * 0.72);
    this.oiLayout = { lo, rows, left, step };
    g.fillStyle = border; g.fillRect(left, Math.round(mid), right - left, 1);
    rows.forEach((r, i) => {
      const x = left + i * step + (step - bw) / 2;
      const c = r.call?.oi || 0, p = r.put?.oi || 0;
      if (c) { g.fillStyle = up; g.fillRect(x, mid - (c / max) * half, bw, (c / max) * half); }
      if (p) { g.fillStyle = down; g.fillRect(x, mid + 1, bw, (p / max) * half); }
    });
    // x of a strike (between bars when it falls between strikes).
    const xOf = (k) => {
      if (!rows.length) return null;
      if (k <= rows[0].strike) return left + step / 2;
      for (let i = 1; i < rows.length; i++) {
        if (k <= rows[i].strike) {
          const f = (k - rows[i - 1].strike) / (rows[i].strike - rows[i - 1].strike);
          return left + (i - 1 + f) * step + step / 2;
        }
      }
      return left + (rows.length - 0.5) * step;
    };
    // The price and max pain: dashed lines, labelled above the chart (max pain's on a chip just
    // inside it). Max pain outside the strikes shown gets an arrow at that edge instead of a line.
    const mp = d.stats.maxPain;
    const mpOut = mp == null || !rows.length ? 0 : mp < rows[0].strike ? -1 : mp > rows[rows.length - 1].strike ? 1 : 0;
    const xs = { spot: xOf(d.stats.spot), mp: mp != null && !mpOut ? xOf(mp) : null };
    const line = (x, col) => {
      g.strokeStyle = col; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, top); g.lineTo(Math.round(x) + 0.5, bottom); g.stroke();
      g.setLineDash([]);
    };
    const label = (x, y, str, col, chip) => {
      const flip = x > w * 0.6; // text on the line's left
      g.textAlign = flip ? 'right' : 'left';
      const tx = x + (flip ? -4 : 4);
      if (chip) {
        const tw = g.measureText(str).width;
        g.fillStyle = color('--bg', '#000');
        g.fillRect(flip ? tx - tw - 3 : tx - 3, y - 10, tw + 6, 13);
      }
      g.fillStyle = col;
      g.fillText(str, tx, y);
    };
    if (xs.mp != null) line(xs.mp, MP);
    if (xs.spot != null) line(xs.spot, text);
    if (xs.spot != null) label(xs.spot, top - 4, `${d.underlying.symbol} ${fmtPrice(d.stats.spot)}`, text, false);
    const mpText = mp == null ? '' : t('opt.maxPainAt', { strike: fmtStrike(mp) });
    if (xs.mp != null) label(xs.mp, bottom - 4, mpText, MP, true);
    else if (mpOut < 0) label(0, bottom - 4, `← ${mpText}`, MP, true);
    else if (mpOut > 0) label(w, bottom - 4, `${mpText} →`, MP, true);
    // Strikes along the bottom.
    g.fillStyle = muted; g.textAlign = 'center';
    const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(w / 64))));
    for (let i = 0; i < rows.length; i += every) {
      const str = fmtStrike(rows[i].strike), half = g.measureText(str).width / 2;
      g.fillText(str, Math.min(w - half - 1, Math.max(half + 1, left + i * step + step / 2)), h - 4);
    }
  }

  /** The chain's hover card: the contract's Greeks and details. */
  onHover(e) {
    const td = e.target.closest?.('td[data-side]');
    if (!td) { if (e.target.tagName !== 'CANVAS') this.tip.hidden = true; return; }
    const d = this.data;
    const r = d?.rows[Number(td.closest('tr').dataset.i)];
    const c = td.dataset.side === 'c' ? r?.call : r?.put;
    if (!c) { this.tip.hidden = true; return; }
    const line = (label, v) => `<span>${esc(label)}</span><b>${v}</b>`;
    const traded = c.traded ? new Date(c.traded * 1000).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
    this.tip.innerHTML = `<div class="hm-tip-head"><b>${esc(t(td.dataset.side === 'c' ? 'opt.callAt' : 'opt.putAt', { strike: fmtStrike(r.strike) }))}</b> <span>${esc(c.symbol)}</span></div>
      <div class="muted">${esc(c.itm ? t('opt.itm') : t('opt.otm'))}${d.source === 'yahoo' ? ` · ${esc(t('opt.clickToOpen'))}` : ''}</div>
      <div class="hm-tip-grid">${[
        line(t('opt.bidAsk'), `${fmtPrice(c.bid)} / ${fmtPrice(c.ask)}`),
        line(t('opt.mid'), fmtPrice(c.mid)),
        c.mark != null ? line(t('opt.mark'), fmtPrice(c.mark)) : '',
        line(t('common.last'), `${fmtPrice(c.last)}${c.change != null && d.source === 'deribit' ? ` <small class="${cls(c.change)}">${fmtPct(c.change, 1)}</small>` : ''}`),
        line(t('opt.volOi'), `${fmtCount(c.volume)} · ${fmtCount(c.oi)}`),
        line('IV', fmtIv(c.iv)),
        line(t('opt.delta'), fmtGreek(c.delta, 3)),
        line(t('opt.gamma'), fmtGreek(c.gamma, c.gamma != null && Math.abs(c.gamma) < 0.001 ? 6 : 4)),
        line(t('opt.theta'), fmtGreek(c.theta, Math.abs(c.theta) >= 100 ? 0 : 3)),
        line(t('opt.vega'), fmtGreek(c.vega, Math.abs(c.vega) >= 100 ? 0 : 3)),
        traded ? line(t('opt.lastTrade'), esc(traded)) : '',
      ].join('')}</div>`;
    this.placeTip(e);
  }

  onChartHover(e) {
    const L = this.oiLayout;
    if (!L) { this.tip.hidden = true; return; }
    const rect = e.target.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - L.left) / L.step);
    const r = L.rows[i];
    if (!r) { this.tip.hidden = true; return; }
    const unit = this.data.source === 'deribit' ? ` ${esc(this.data.unit)}` : '';
    this.tip.innerHTML = `<div class="hm-tip-head"><b>${esc(t('opt.strikeHead', { strike: fmtStrike(r.strike) }))}</b></div>
      <div class="hm-tip-grid"><span>${esc(t('opt.callOi'))}</span><b class="up">${fmtCount(r.call?.oi)}${unit}</b><span>${esc(t('opt.putOi'))}</span><b class="down">${fmtCount(r.put?.oi)}${unit}</b>
      <span>${esc(t('opt.callVol'))}</span><b>${fmtCount(r.call?.volume)}</b><span>${esc(t('opt.putVol'))}</span><b>${fmtCount(r.put?.volume)}</b></div>`;
    this.placeTip(e);
  }

  placeTip(e) {
    this.tip.hidden = false;
    const pad = 14;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const x = e.clientX + pad + tw > window.innerWidth ? e.clientX - tw - pad : e.clientX + pad;
    const y = e.clientY + pad + th > window.innerHeight ? e.clientY - th - pad : e.clientY + pad;
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${Math.max(4, y)}px`;
  }
}
