// A live-updating list of symbols with last price and change (used by the watchlist and Markets).
// The watchlist's version also has sections (named groups that collapse) and drag-to-reorder.

import { QuoteStream, displayTicker, sourceName } from './datafeed.js';
import { esc, formatNumber, smartDecimals, fixed } from './util.js';
import { t } from './i18n.js';

const ICON_STAR = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/></svg>';
const ICON_ARROW = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DRAG_START = 5; // pixels the pointer moves before a press becomes a drag

export class QuoteList {
  /**
   * opts: onSelect(full), onRemove(full) → shows ×, onStar(full) + isStarred(full) → shows ☆,
   *       empty: text when the list is empty,
   *       onMove(from, to): rows can be dragged; the entry at index `from` goes before the one at `to`,
   *       sections: { onToggle(name), onRename(name, newName), onRemove(name) } for section rows.
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.items = [];
    this.active = null;
    this.quotes = new Map();
    this.stream = new QuoteStream((full, q) => this.onQuote(full, q), { useCredits: !!opts.useCredits });
    el.addEventListener('click', (e) => {
      if (this.dragged) return; // the click that ends a drag
      const sec = e.target.closest('.wl-sec');
      if (sec) {
        if (e.target.closest('input')) return;
        if (e.target.closest('.wl-sec-del')) this.opts.sections?.onRemove(sec.dataset.sec);
        else this.opts.sections?.onToggle(sec.dataset.sec);
        return;
      }
      const row = e.target.closest('.wl-row');
      if (!row) return;
      if (e.target.closest('.wl-del')) { this.opts.onRemove?.(row.dataset.sym); return; }
      if (e.target.closest('.wl-star')) { this.opts.onStar?.(row.dataset.sym); this.refreshStars(); return; }
      this.opts.onSelect(row.dataset.sym);
    });
    el.addEventListener('dblclick', (e) => {
      const name = e.target.closest('.wl-sec-name');
      if (name) this.editSection(name.closest('.wl-sec').dataset.sec);
    });
    if (opts.onMove) this.enableDrag();
  }

  /** items: [{ full, name?, price?, change?, precision? } or { section, collapsed }] */
  setItems(items) {
    this.items = items;
    for (const it of items) {
      if (!it.section && Number.isFinite(it.price) && !this.quotes.has(it.full)) {
        this.quotes.set(it.full, { price: it.price, change: it.change, precision: it.precision });
      }
    }
    this.render();
    this.stream.setSymbols(items.filter((i) => !i.section).map((i) => i.full));
  }

  stop() { this.stream.stop(); }

  setActive(full) {
    this.active = full;
    this.el.querySelectorAll('.wl-row').forEach((r) => r.classList.toggle('active', r.dataset.sym === full));
  }

  render() {
    const { onRemove, onStar } = this.opts;
    const scroll = this.el.scrollTop;
    let hidden = false; // inside a collapsed section
    this.el.innerHTML = this.items.map((it, i) => {
      if (it.section != null) {
        hidden = !!it.collapsed;
        return `<div class="wl-sec${it.collapsed ? ' closed' : ''}" data-i="${i}" data-sec="${esc(it.section)}">
          <button class="wl-sec-toggle" title="${esc(t('wl.collapse'))}" aria-label="${esc(t('wl.collapse'))}" aria-expanded="${!it.collapsed}">${ICON_ARROW}</button>
          <span class="wl-sec-name" title="${esc(t('wl.renameHint'))}">${esc(it.section)}</span>
          <button class="wl-sec-del" title="${esc(t('wl.deleteSection'))}" aria-label="${esc(t('wl.deleteSection'))}">×</button>
        </div>`;
      }
      return `
      <div class="wl-row${it.full === this.active ? ' active' : ''}" data-i="${i}" data-sym="${esc(it.full)}" title="${esc(it.name || '')}"${hidden ? ' hidden' : ''}>
        ${this.opts.onMove ? '<span class="wl-grip" aria-hidden="true"></span>' : ''}
        <span class="wl-sym"><b>${esc(displayTicker(it.full))}</b><small>${esc(it.name || sourceName(it.full))}</small></span>
        <span class="wl-price">—</span>
        <span class="wl-chg">—</span>
        ${onRemove ? `<button class="wl-del" title="${t('common.remove')}" aria-label="${t('common.remove')}">×</button>` : ''}
        ${onStar ? `<button class="wl-star" title="${t('mk.watchToggleTitle')}" aria-label="${t('mk.watchToggleAria')}">${ICON_STAR}</button>` : ''}
      </div>`;
    }).join('') || `<div class="wl-empty">${esc(this.opts.empty || t('mk.nothingHere'))}</div>`;
    this.el.scrollTop = scroll;
    for (const [full, q] of this.quotes) this.paint(full, q, false);
    this.refreshStars();
  }

  /** Turns a section's name into a text box (Enter or leaving it saves, Esc cancels). */
  editSection(name) {
    const row = [...this.el.querySelectorAll('.wl-sec')].find((r) => r.dataset.sec === name);
    const label = row?.querySelector('.wl-sec-name');
    if (!label) return;
    const input = document.createElement('input');
    input.className = 'wl-sec-input';
    input.value = name;
    input.maxLength = 40;
    input.setAttribute('aria-label', t('wl.sectionName'));
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== name) this.opts.sections?.onRename(name, input.value);
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing a name mustn't trigger the chart's shortcuts
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- drag to reorder ---------------------------------------------------------
  // Mouse: press a row (or a section's header) and move. Touch: the grip at the row's left edge,
  // so a finger can still scroll the list.
  enableDrag() {
    const el = this.el;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input')) return;
      const row = e.target.closest('.wl-row, .wl-sec');
      if (!row || (e.pointerType === 'touch' && !e.target.closest('.wl-grip'))) return;
      drag = { row, id: e.pointerId, y: e.clientY, on: false, to: null };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y) < DRAG_START) return;
        drag.on = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
        drag.row.classList.add('dragging');
        el.classList.add('wl-dragging');
      }
      e.preventDefault();
      const box = el.getBoundingClientRect();
      if (e.clientY < box.top + 28) el.scrollTop -= 14;
      else if (e.clientY > box.bottom - 28) el.scrollTop += 14;
      drag.to = this.dropIndex(e.clientY, drag.row.classList.contains('wl-sec'));
      this.showDrop(drag.to);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      d.row.classList.remove('dragging');
      el.classList.remove('wl-dragging');
      this.showDrop(null);
      this.dragged = true; // swallow the click that follows
      setTimeout(() => { this.dragged = false; }, 0);
      if (e.type === 'pointerup' && d.to != null) this.opts.onMove(Number(d.row.dataset.i), d.to);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /**
   * Where a drop at height y goes: the index of the visible row below the pointer's half-way mark.
   * A section only lands between sections (or at the end), so the line shows where it really goes.
   */
  dropIndex(y, section = false) {
    let to = this.items.length;
    for (const row of this.el.querySelectorAll('.wl-row:not([hidden]), .wl-sec')) {
      const r = row.getBoundingClientRect();
      if (y < r.top + r.height / 2) { to = Number(row.dataset.i); break; }
    }
    if (section) while (to < this.items.length && this.items[to].section == null) to++;
    return to;
  }

  showDrop(to) {
    if (!this.dropLine?.isConnected) {
      this.dropLine = document.createElement('div');
      this.dropLine.className = 'wl-drop';
      this.el.append(this.dropLine);
    }
    if (to == null) { this.dropLine.hidden = true; return; }
    const rows = [...this.el.querySelectorAll('.wl-row:not([hidden]), .wl-sec')];
    const below = rows.find((r) => Number(r.dataset.i) >= to);
    const last = rows[rows.length - 1];
    this.dropLine.hidden = false;
    const y = below ? below.offsetTop - 1 : last ? last.offsetTop + last.offsetHeight - 2 : 0;
    this.dropLine.style.top = `${Math.max(0, y)}px`; // at the very top, keep it inside the list
  }

  refreshStars() {
    if (!this.opts.isStarred) return;
    this.el.querySelectorAll('.wl-row').forEach((r) => r.querySelector('.wl-star')?.classList.toggle('on', this.opts.isStarred(r.dataset.sym)));
  }

  onQuote(full, q) {
    const prev = this.quotes.get(full);
    const next = { ...prev, ...q, precision: q.precision ?? prev?.precision };
    this.quotes.set(full, next);
    this.paint(full, next, prev && prev.price !== q.price ? (q.price > prev.price ? 'up' : 'down') : false);
  }

  paint(full, q, flash) {
    const row = this.el.querySelector(`.wl-row[data-sym="${CSS.escape(full)}"]`);
    if (!row) return;
    const price = row.querySelector('.wl-price');
    const chg = row.querySelector('.wl-chg');
    price.textContent = formatNumber(q.price, q.precision ?? smartDecimals(q.price));
    if (q.change == null || !Number.isFinite(q.change)) {
      chg.textContent = '—';
      chg.className = 'wl-chg';
    } else {
      chg.textContent = `${q.change >= 0 ? '+' : ''}${fixed(q.change, 2)}%`;
      chg.className = `wl-chg ${q.change >= 0 ? 'up' : 'down'}`;
    }
    if (flash) {
      price.classList.remove('flash-up', 'flash-down');
      void price.offsetWidth; // restart the animation
      price.classList.add(flash === 'up' ? 'flash-up' : 'flash-down');
    }
  }

  lastPrice(full) { return this.quotes.get(full)?.price; }
}
