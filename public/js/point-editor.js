// Edit a drawing by the numbers (issue #6): the exact price and date/time of each of its points,
// and a label for lines and shapes. Opened by double-clicking a drawing or the pencil in its toolbar.
// The pure parts (which fields a drawing has, reading and writing the date/time box) are exported
// for the tests; chart-view.js applies the edits through the drawing layer.

import { t } from './i18n.js';
import { esc } from './util.js';

/** Drawings that can carry a label of their own (text and arrow symbols already have one). */
export const LABEL_TOOLS = new Set(['trend', 'ray', 'extended', 'arrow', 'channel', 'hline', 'hray', 'vline', 'rect']);

/**
 * The points a drawing's editor shows: [{ key, name, price, time }]. price / time say whether that
 * part of the point means anything for the drawing (a horizontal line has no time, a vertical line
 * no price; a position's stop shares the entry's time).
 */
export function editablePoints(d) {
  const P = (key, name, price = true, time = true) => ({ key, name, price, time });
  const n = (k) => t('draw.ed.point', { n: k });
  switch (d?.type) {
    case 'hline': return [P('p1', t('draw.ed.level'), true, false)];
    case 'vline': return [P('p1', t('draw.ed.time'), false, true)];
    case 'avwap': return [P('p1', t('draw.ed.anchor'), false, true)];
    case 'hray': case 'text': case 'arrowUp': case 'arrowDown': return [P('p1', n(1))];
    case 'long': case 'short':
      return [P('p1', t('draw.ed.entry')), P('p2', t('draw.ed.target')), P('p3', t('draw.ed.stop'), true, false)];
    case 'channel': return [P('p1', n(1)), P('p2', n(2)), P('p3', n(3))];
    case undefined: case null: return [];
    default: return [P('p1', n(1)), P('p2', n(2))];
  }
}

const pad = (v) => String(v).padStart(2, '0');

/**
 * A chart time (seconds; chart times are wall-clock times stored as UTC) for the date box: "2026-11-20"
 * on daily charts, "2026-11-20T14:35" (a datetime-local value) otherwise.
 */
export function timeToInput(time, daily) {
  const d = new Date(time * 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return daily ? date : `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** The date box's value back to a chart time, or null when it isn't a complete date (and time). */
export function inputToTime(value, daily) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(value || '').trim());
  if (!m || (!daily && m[4] == null) || +m[1] < 1900) return null; // year 0002: still being typed
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * A price typed by the user, or null when it isn't a number: "1234.5", "1,234.5", "1.234,5", "1234,5".
 * With both separators the last one is the decimal mark; with one kind only, it's the decimal mark
 * unless it groups thousands the way the UI language writes them (decimalComma: the language
 * writes 1,5) — so "1,234" is 1234 in English and 1.234 in German.
 */
export function parsePrice(text, decimalComma = false) {
  let s = String(text ?? '').trim().replace(/[\s  ']/g, '');
  if (!s) return null;
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) s = !decimalComma && /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (dot >= 0 && decimalComma && /^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * The changes for one edited field, as a patch for the drawing: { p1: {...} } and, for a position,
 * the stop's time follows the entry's (its handle sits at the entry).
 */
export function pointPatch(d, key, field, value) {
  const point = { ...d[key], [field]: value };
  const patch = { [key]: point };
  if ((d.type === 'long' || d.type === 'short') && key === 'p1' && field === 'time' && d.p3) patch.p3 = { ...d.p3, time: value };
  return patch;
}

// --- the panel ----------------------------------------------------------------------------------

const panel = { el: null, id: null, d: null, opts: null };

/** A price for the price box: rounded to the symbol's decimals, with the language's decimal mark. */
function fmtPrice(v, opts) {
  if (!Number.isFinite(v)) return '';
  const s = String(+v.toFixed(Math.min(10, Math.max(0, opts.precision ?? 2))));
  return opts.decimalComma ? s.replace('.', ',') : s;
}

function render() {
  const { d, opts } = panel;
  const daily = opts.daily;
  const fmt = (v) => fmtPrice(v, opts);
  const rows = editablePoints(d).map((p) => `
    <div class="pe-point" data-key="${p.key}">
      <div class="pop-section">${esc(p.name)}</div>
      ${p.price ? `<label class="pe-field"><span>${esc(t('draw.ed.price'))}</span>
        <input type="text" inputmode="decimal" data-pe="price" value="${esc(fmt(d[p.key]?.price))}" aria-label="${esc(`${p.name}: ${t('draw.ed.price')}`)}"></label>` : ''}
      ${p.time ? `<label class="pe-field"><span>${esc(t(daily ? 'draw.ed.date' : 'draw.ed.dateTime'))}</span>
        <input type="${daily ? 'date' : 'datetime-local'}" data-pe="time" value="${esc(timeToInput(d[p.key]?.time ?? 0, daily))}" aria-label="${esc(`${p.name}: ${t(daily ? 'draw.ed.date' : 'draw.ed.dateTime')}`)}"></label>` : ''}
    </div>`).join('');
  const label = LABEL_TOOLS.has(d.type) ? `
    <div class="pop-section"></div>
    <label class="pe-field pe-label"><span>${esc(t('draw.ed.label'))}</span>
      <input type="text" maxlength="60" data-pe="label" value="${esc(d.label || '')}" placeholder="${esc(t('draw.ed.labelPh'))}"></label>` : '';
  panel.el.innerHTML = `<div class="pop-title">${esc(opts.title)}</div>${rows}${label}
    <div class="pop-actions"><button class="btn-primary" data-pe="done">${esc(t('common.done'))}</button></div>`;
}

function ensurePanel() {
  if (panel.el) return;
  const el = document.createElement('div');
  el.className = 'popover point-editor';
  el.hidden = true;
  document.body.append(el);
  panel.el = el;
  // A field is applied when it's left or Enter is pressed (text boxes report that as "change"), and
  // a date as soon as it's a whole date: picked from the calendar, or typed (a date box reports
  // "change" after every part, with a year of 0002 on the way to 2026: those are skipped). A value
  // that doesn't parse goes back to the drawing's when the box is left.
  const commit = (input, restore = true) => {
    const what = input.dataset.pe;
    if (!panel.d || !panel.opts || !what) return;
    if (what === 'label') { panel.opts.onChange({ label: input.value.trim() || undefined }); return; }
    const key = input.closest('.pe-point')?.dataset.key;
    if (!key) return;
    const value = what === 'price' ? parsePrice(input.value, panel.opts.decimalComma) : inputToTime(input.value, panel.opts.daily);
    const old = panel.d[key]?.[what];
    if (value == null) { // back to the drawing's value, in place (rebuilding the panel would lose the focus)
      if (restore) input.value = what === 'price' ? fmtPrice(old, panel.opts) : timeToInput(old ?? 0, panel.opts.daily);
      return;
    }
    if (value !== old) panel.opts.onChange(pointPatch(panel.d, key, what, value));
  };
  el.addEventListener('change', (e) => commit(e.target, e.target.dataset.pe !== 'time'));
  el.addEventListener('focusout', (e) => { if (e.target.dataset?.pe === 'time') commit(e.target); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-pe="done"]')) closePointEditor(); });
  // Typing here must not reach the chart's shortcuts (Delete would remove the drawing).
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closePointEditor();
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  });
  document.addEventListener('mousedown', (e) => {
    if (!el.hidden && !el.contains(e.target) && !e.target.closest('[data-db="edit"]')) closePointEditor();
  });
}

/**
 * Opens the editor for drawing d near `anchor` (an element, or { x, y } on screen).
 * opts: { title, daily, precision, decimalComma, onChange(patch) }.
 */
export function openPointEditor(anchor, d, opts) {
  ensurePanel();
  panel.id = d.id;
  panel.d = d;
  panel.opts = opts;
  render();
  const { el } = panel;
  el.hidden = false;
  const r = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor?.x ?? 100, bottom: anchor?.y ?? 100 };
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))}px`;
  el.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 12))}px`;
  el.querySelector('input')?.focus();
}

/** The drawing changed (dragged, or an edit applied): show its values again, unless a field is being typed in. */
export function refreshPointEditor(d) {
  if (!panel.el || panel.el.hidden || panel.id !== d?.id) return;
  panel.d = d;
  if (!panel.el.contains(document.activeElement)) render();
}

export function closePointEditor() {
  if (panel.el) panel.el.hidden = true;
  panel.id = null;
  panel.d = null;
  panel.opts = null;
}

/** Id of the drawing the editor is open for, or null. */
export const pointEditorId = () => (panel.el && !panel.el.hidden ? panel.id : null);
