// Appearance: theme presets plus any color the user picks. Each preset has a dark and a light
// palette; the user's own colors are stored per mode on top of the chosen preset.

import { store, withAlpha } from './util.js';
import { setChartPalette } from './chart-view.js';
import { setTrendColors } from './indicators.js';
import { t } from './i18n.js';

export const PRESETS = {
  crimson: {
    name: t('theme.preset.crimson'),
    dark: {
      accent: '#E5484D', bg: '#0F0F11', panel: '#17171A', border: '#26262B', text: '#E4E1E1', muted: '#8D898B',
      chartBg: '#0F0F11', grid: '#1B1B1F', scaleText: '#A8A4A6', crosshair: '#77737A', up: '#2EBD85', down: '#F6465D',
    },
    light: {
      accent: '#D93A40', bg: '#FCFBFB', panel: '#FFFFFF', border: '#E8E4E4', text: '#1C1A1B', muted: '#77717A',
      chartBg: '#FFFFFF', grid: '#F1EEEE', scaleText: '#1C1A1B', crosshair: '#9A949A', up: '#1E9E6A', down: '#E0384C',
    },
  },
  ember: {
    name: t('theme.preset.ember'),
    dark: {
      accent: '#F2A33A', bg: '#0F1012', panel: '#16181B', border: '#24272B', text: '#D9D5CD', muted: '#8E8A82',
      chartBg: '#0F1012', grid: '#1A1C1F', scaleText: '#A9A49B', crosshair: '#7A766F', up: '#34B886', down: '#EC5246',
    },
    light: {
      accent: '#E08D2A', bg: '#FCFBF8', panel: '#FFFFFF', border: '#E7E2D8', text: '#1E1B17', muted: '#7A746A',
      chartBg: '#FCFBF8', grid: '#F0EDE6', scaleText: '#1E1B17', crosshair: '#9A948A', up: '#1E9A68', down: '#D8433A',
    },
  },
  dusk: {
    name: t('theme.preset.dusk'),
    dark: {
      accent: '#9D8CFB', bg: '#100F1A', panel: '#171627', border: '#26243C', text: '#E8E6F5', muted: '#8B88A8',
      chartBg: '#100F1A', grid: '#1A1929', scaleText: '#ABA8C4', crosshair: '#77739A', up: '#2DD4BF', down: '#FB7185',
    },
    light: {
      accent: '#6B57E6', bg: '#F8F7FD', panel: '#FFFFFF', border: '#E3E0F2', text: '#1B1830', muted: '#6E6A8C',
      chartBg: '#F8F7FD', grid: '#EEECF7', scaleText: '#1B1830', crosshair: '#9893B5', up: '#0E9F8E', down: '#E2486B',
    },
  },
  signal: {
    name: t('theme.preset.signal'),
    dark: {
      accent: '#B5F23D', bg: '#0A0C0B', panel: '#111412', border: '#202622', text: '#E3EAE4', muted: '#7E8A81',
      chartBg: '#0A0C0B', grid: '#141815', scaleText: '#A3AEA6', crosshair: '#6E7A71', up: '#34D399', down: '#F43F5E',
    },
    light: {
      accent: '#4D7C0F', bg: '#F7F9F6', panel: '#FFFFFF', border: '#DCE3DB', text: '#131A14', muted: '#68736A',
      chartBg: '#F7F9F6', grid: '#ECF0EB', scaleText: '#131A14', crosshair: '#8E988F', up: '#15803D', down: '#E11D48',
    },
  },
  ink: {
    name: t('theme.preset.ink'),
    dark: {
      accent: '#FF6B4A', bg: '#111111', panel: '#181818', border: '#2A2A2A', text: '#EDEDED', muted: '#8F8F8F',
      chartBg: '#111111', grid: '#1B1B1B', scaleText: '#AAAAAA', crosshair: '#777777', up: '#EDEDED', down: '#FF6B4A',
    },
    light: {
      accent: '#F2542D', bg: '#FFFFFF', panel: '#FAFAFA', border: '#E6E6E6', text: '#111111', muted: '#777777',
      chartBg: '#FFFFFF', grid: '#F2F2F2', scaleText: '#111111', crosshair: '#999999', up: '#111111', down: '#F2542D',
    },
  },
};
export const DEFAULT_PRESET = 'crimson';

/** Every color the user can pick, in the order the Appearance dialog shows them. */
export const FIELDS = [
  { group: t('theme.group.interface'), key: 'accent', label: t('theme.field.accent') },
  { group: t('theme.group.interface'), key: 'bg', label: t('theme.field.bg') },
  { group: t('theme.group.interface'), key: 'panel', label: t('theme.field.panel') },
  { group: t('theme.group.interface'), key: 'border', label: t('theme.field.border') },
  { group: t('theme.group.interface'), key: 'text', label: t('theme.field.text') },
  { group: t('theme.group.interface'), key: 'muted', label: t('theme.field.muted') },
  { group: t('theme.group.chart'), key: 'chartBg', label: t('theme.field.chartBg') },
  { group: t('theme.group.chart'), key: 'grid', label: t('theme.field.grid') },
  { group: t('theme.group.chart'), key: 'scaleText', label: t('theme.field.scaleText') },
  { group: t('theme.group.chart'), key: 'crosshair', label: t('theme.field.crosshair') },
  { group: t('theme.group.candles'), key: 'up', label: t('theme.field.up') },
  { group: t('theme.group.candles'), key: 'down', label: t('theme.field.down') },
  { group: t('theme.group.candles'), key: 'wickUp', label: t('theme.field.wickUp') },
  { group: t('theme.group.candles'), key: 'wickDown', label: t('theme.field.wickDown') },
  { group: t('theme.group.candles'), key: 'line', label: t('theme.field.line') },
];

// --- color math --------------------------------------------------------------------------
const rgb = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// --- state --------------------------------------------------------------------------------
let state = load();
function load() {
  const s = store.get('appearance', null);
  return {
    preset: PRESETS[s?.preset] ? s.preset : DEFAULT_PRESET,
    custom: { dark: { ...s?.custom?.dark }, light: { ...s?.custom?.light } },
  };
}
const save = () => store.set('appearance', state);

export const currentMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export const presetId = () => state.preset;
export const isCustomized = (mode = currentMode()) => Object.keys(state.custom[mode]).length > 0;

/** The resolved colors for a mode: preset, then the user's picks, then derived defaults. */
export function palette(mode = currentMode()) {
  const p = { ...PRESETS[state.preset][mode], ...state.custom[mode] };
  p.wickUp ||= p.up;
  p.wickDown ||= p.down;
  p.line ||= p.accent;
  return p;
}

function cssVars(p, mode) {
  const dark = mode === 'dark';
  return {
    '--bg': p.bg,
    '--chart-bg': p.chartBg, // the legend's halo (style.css) must match the chart, not the page (issue #10)
    '--panel': p.panel,
    '--panel-2': mix(p.panel, p.text, dark ? 0.07 : 0.05),
    '--hover': mix(p.panel, p.text, dark ? 0.09 : 0.06),
    '--border': p.border,
    '--text': p.text,
    '--text-strong': dark ? mix(p.text, '#FFFFFF', 0.4) : p.text,
    '--muted': p.muted,
    '--accent': p.accent,
    '--accent-hover': mix(p.accent, dark ? '#FFFFFF' : '#000000', 0.15),
    '--accent-text': dark ? mix(p.accent, '#FFFFFF', 0.18) : mix(p.accent, '#000000', 0.2),
    '--accent-soft': withAlpha(p.accent, dark ? 0.16 : 0.12),
    '--on-accent': luminance(p.accent) > 0.3 ? '#141414' : '#FFFFFF',
    '--up': dark ? p.up : mix(p.up, '#000000', 0.1),
    '--down': dark ? p.down : mix(p.down, '#000000', 0.08),
  };
}

let chartTimer = null;
/** Applies the current palette to the page at once, and to every chart (debounced while dragging a picker). */
export function applyAppearance({ immediate = true } = {}) {
  const mode = currentMode();
  const p = palette(mode);
  const vars = cssVars(p, mode);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  store.set('paint', { mode, vars }); // lets index.html paint the right colors before the app loads
  const charts = () => {
    setTrendColors(p.up, p.down);
    setChartPalette(mode, {
      bg: p.chartBg, text: p.scaleText, grid: p.grid, border: p.border, crosshair: p.crosshair,
      label: mix(p.chartBg, p.text, dark(mode) ? 0.22 : 0.85), separator: p.border, strong: p.text, level: p.muted,
    }, { up: p.up, down: p.down, wickUp: p.wickUp, wickDown: p.wickDown, line: p.line, accent: p.accent });
    for (const fn of listeners) fn(p, mode);
  };
  clearTimeout(chartTimer);
  if (immediate) charts(); else chartTimer = setTimeout(charts, 120);
}
const dark = (mode) => mode === 'dark';

const listeners = new Set();
export const onAppearanceChange = (fn) => listeners.add(fn);

export function setPreset(id) {
  if (!PRESETS[id]) return;
  state = { preset: id, custom: { dark: {}, light: {} } };
  save();
  applyAppearance();
}

export function setColor(key, value, { live = false } = {}) {
  state.custom[currentMode()][key] = value.toUpperCase();
  save();
  applyAppearance({ immediate: !live });
}

export function resetColors() {
  state.custom[currentMode()] = {};
  save();
  applyAppearance();
}
