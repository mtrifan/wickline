// The settings panel of a Fibonacci retracement: edit the levels (value, color, on/off, add, remove) and
// the options (trend line, labels, background, extending the lines, log scale). It only shows and edits;
// the rules and the saved shape live in fib.js, and chart-view.js decides where the result is stored.

import { t } from './i18n.js';
import { addLevel, fibOf, formatLevel, FIB_LIMITS, parseLevel, removeLevel, setLevel, setOption } from './fib.js';

/** Options in the order the panel lists them, with the text key of each. */
const OPTION_ROWS = [
  ['trend', 'fib.trend'], ['showLevel', 'fib.showLevel'], ['showPrice', 'fib.showPrice'], ['fill', 'fib.fill'],
  ['extendLeft', 'fib.extendLeft'], ['extendRight', 'fib.extendRight'], ['log', 'fib.log'],
];

const panel = { el: null, id: null, cfg: null, onChange: null, onReset: null };

const levelRow = (l, i) => `
  <div class="fib-row" data-i="${i}">
    <input type="checkbox" data-fib="on"${l.on ? ' checked' : ''} title="${t('fib.levelOn')}" aria-label="${t('fib.levelOn')}">
    <input type="text" inputmode="decimal" data-fib="value" value="${formatLevel(l.value)}" title="${t('fib.levelValue')}" aria-label="${t('fib.levelValue')}">
    <input type="color" data-fib="color" value="${l.color}" title="${t('fib.levelColor')}" aria-label="${t('fib.levelColor')}">
    <button data-fib="remove" title="${t('fib.removeLevel')}" aria-label="${t('fib.removeLevel')}">×</button>
  </div>`;

function render() {
  const { cfg } = panel;
  panel.el.innerHTML = `
    <div class="pop-title">${t('draw.tool.fib')}</div>
    <div class="pop-section">${t('fib.levels')}</div>
    <div class="fib-levels">${cfg.levels.map(levelRow).join('')}</div>
    <button class="btn-ghost fib-add" data-fib="add"${cfg.levels.length >= FIB_LIMITS.maxLevels ? ' disabled' : ''}>+ ${t('fib.addLevel')}</button>
    <div class="pop-section"></div>
    ${OPTION_ROWS.map(([key, text]) => `
      <label class="pop-field"${key === 'log' ? ` title="${t('fib.logHint')}"` : ''}><span>${t(text)}</span>
        <input type="checkbox" data-fib="opt" data-key="${key}"${cfg[key] ? ' checked' : ''}>
      </label>`).join('')}
    <div class="pop-actions">
      <button class="btn-ghost" data-fib="reset">${t('common.reset')}</button>
      <button class="btn-primary" data-fib="close">${t('common.done')}</button>
    </div>`;
}

function commit(cfg) {
  panel.cfg = cfg;
  panel.onChange?.(cfg);
}

function ensurePanel() {
  if (panel.el) return;
  const el = document.createElement('div');
  el.className = 'popover fib-panel';
  el.hidden = true;
  document.body.append(el);
  panel.el = el;

  el.addEventListener('input', (e) => {
    const row = e.target.closest('.fib-row');
    if (e.target.dataset.fib === 'color' && row) commit(setLevel(panel.cfg, Number(row.dataset.i), { color: e.target.value }));
  });
  el.addEventListener('change', (e) => {
    const input = e.target;
    const row = input.closest('.fib-row');
    const i = row ? Number(row.dataset.i) : -1;
    if (input.dataset.fib === 'on' && row) commit(setLevel(panel.cfg, i, { on: input.checked }));
    else if (input.dataset.fib === 'opt') commit(setOption(panel.cfg, input.dataset.key, input.checked));
    else if (input.dataset.fib === 'value' && row) {
      const value = parseLevel(input.value);
      if (value == null) input.value = formatLevel(panel.cfg.levels[i].value); // not a number: keep the old one
      else { commit(setLevel(panel.cfg, i, { value })); input.value = formatLevel(value); }
    }
  });
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fib]');
    if (!btn) return;
    const what = btn.dataset.fib;
    if (what === 'close') closeFibPanel();
    else if (what === 'remove') { commit(removeLevel(panel.cfg, Number(btn.closest('.fib-row').dataset.i))); render(); }
    else if (what === 'add') {
      commit(addLevel(panel.cfg));
      render();
      const last = el.querySelector('.fib-row:last-child [data-fib="value"]');
      last?.focus();
      last?.select();
    } else if (what === 'reset') {
      panel.cfg = fibOf({});
      panel.onReset?.();
      render();
    }
  });
  // Typing here must not reach the app's shortcuts (Delete would remove the drawing).
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFibPanel();
    else if (e.key === 'Enter' && e.target.dataset.fib === 'value') e.target.blur();
    e.stopPropagation();
  });
  document.addEventListener('mousedown', (e) => {
    if (!el.hidden && !el.contains(e.target) && !e.target.closest('[data-db="fib"]')) closeFibPanel();
  });
}

/** Opens the panel under `anchor` for a Fib drawing. onChange(cfg) gets every edit; onReset() the reset. */
export function openFibPanel(anchor, drawing, { onChange, onReset }) {
  ensurePanel();
  panel.id = drawing.id;
  panel.cfg = fibOf(drawing);
  panel.onChange = onChange;
  panel.onReset = onReset;
  render();
  const { el } = panel;
  el.hidden = false;
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 12))}px`;
  el.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 12))}px`;
}

export function closeFibPanel() {
  if (panel.el) panel.el.hidden = true;
  panel.id = null;
  panel.onChange = null;
  panel.onReset = null;
}

/** Id of the drawing the panel is open for, or null. */
export const fibPanelId = () => (panel.el && !panel.el.hidden ? panel.id : null);
