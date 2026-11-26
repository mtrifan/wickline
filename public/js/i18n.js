// UI language: English (also the fallback for any missing text), Simplified and Traditional Chinese,
// Japanese, Korean, Spanish, Brazilian Portuguese, Italian, German and French.
// The dictionaries are flat { key: text } objects in js/lang/<id>.js; English is the source.
// Text may hold {name} placeholders, and a value may be { one, other } for plurals (picked by
// Intl.PluralRules from vars.n). Switching the language saves it and reloads the page, so a
// module can translate its constants once, at load.

import en from './lang/en.js';
import zhCN from './lang/zh-CN.js';
import ja from './lang/ja.js';
import zhTW from './lang/zh-TW.js';
import ko from './lang/ko.js';
import es from './lang/es.js';
import ptBR from './lang/pt-BR.js';
import it from './lang/it.js';
import de from './lang/de.js';
import fr from './lang/fr.js';

/** name: in its own language (the picker shows it as is); locale: the Intl default for numbers and dates. */
export const LANGUAGES = [
  { id: 'en', name: 'English', locale: 'en-US' },
  { id: 'zh-CN', name: '简体中文', locale: 'zh-CN' },
  { id: 'zh-TW', name: '繁體中文', locale: 'zh-TW' },
  { id: 'ja', name: '日本語', locale: 'ja-JP' },
  { id: 'ko', name: '한국어', locale: 'ko-KR' },
  { id: 'es', name: 'Español', locale: 'es-ES' },
  { id: 'pt-BR', name: 'Português (Brasil)', locale: 'pt-BR' },
  { id: 'it', name: 'Italiano', locale: 'it-IT' },
  { id: 'de', name: 'Deutsch', locale: 'de-DE' },
  { id: 'fr', name: 'Français', locale: 'fr-FR' },
];
const DICTS = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, 'pt-BR': ptBR, it, de, fr };
const KEY = 'wickline.lang';

/**
 * A system language tag -> a UI language: zh-TW / zh-HK / zh-MO / zh-Hant* -> 'zh-TW', other zh -> 'zh-CN',
 * ja* -> 'ja', ko* -> 'ko', es* -> 'es', pt* -> 'pt-BR', it* -> 'it', de* -> 'de', fr* -> 'fr', anything else -> 'en'.
 */
export function langFromLocale(tag) {
  const parts = String(tag || '').toLowerCase().split(/[-_]/);
  switch (parts[0]) {
    case 'zh': return !parts.includes('hans') && parts.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? 'zh-TW' : 'zh-CN';
    case 'ja': return 'ja';
    case 'ko': return 'ko';
    case 'es': return 'es';
    case 'pt': return 'pt-BR';
    case 'it': return 'it';
    case 'de': return 'de';
    case 'fr': return 'fr';
    default: return 'en';
  }
}

const systemTag = () => (typeof navigator === 'undefined' ? '' : navigator.languages?.[0] || navigator.language || '');

function detect() {
  // Node (the unit tests) and web workers have no page: English.
  if (typeof document === 'undefined') return 'en';
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (DICTS[saved]) return saved;
  } catch { /* no storage */ }
  return langFromLocale(systemTag());
}

/** The UI language now: one of the LANGUAGES ids. */
export const lang = detect();
/**
 * The BCP 47 locale for Intl and toLocale…String(): the system's own variant when it is in the same
 * language (es-MX writes 1,234.5 and es-ES 1.234,5), else the language's default. English is always en-US.
 */
export const locale = (() => {
  const own = LANGUAGES.find((l) => l.id === lang).locale;
  const sys = systemTag();
  if (lang === 'en' || !sys || langFromLocale(sys) !== lang) return own;
  try { return Intl.getCanonicalLocales(sys)[0]; } catch { return own; }
})();
const dict = DICTS[lang];
const plurals = new Intl.PluralRules(locale);

/** The saved language, or null when it follows the system. */
export function savedLang() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return DICTS[v] ? v : null; } catch { return null; }
}

/** Saves the language (null: follow the system). The caller reloads the page. */
export function setLang(id) {
  try {
    if (DICTS[id]) localStorage.setItem(KEY, JSON.stringify(id));
    else localStorage.removeItem(KEY);
  } catch { /* no storage */ }
}

/**
 * The text for a key in the UI language (English if it has none, the key itself if neither
 * does), with {placeholders} filled from vars. Values are inserted as given: escape them first
 * when the result goes into innerHTML.
 */
export function t(key, vars) {
  let s = dict[key] ?? en[key];
  if (s == null) return key;
  if (typeof s === 'object') {
    const n = typeof vars?.n === 'number' ? vars.n : Number(String(vars?.n ?? '').replace(/[^\d.-]/g, ''));
    s = s[plurals.select(Number.isFinite(n) ? n : 0)] ?? s.other;
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
}

/** True when the dictionary (or English) has this key. */
export const hasKey = (key) => key in dict || key in en;

/**
 * Translates the static markup under root: data-i18n (text), data-i18n-html (markup),
 * data-i18n-title, data-i18n-placeholder and data-i18n-aria-label. On an element that also holds
 * other elements (an icon, a count badge), data-i18n replaces only its first piece of text.
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const s = t(el.dataset.i18n);
    if (!el.childElementCount) { el.textContent = s; continue; }
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (node) node.textContent = node.textContent.replace(node.textContent.trim(), s);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = lang;
  // Another window (a pop-out chart) switched the language: follow it.
  addEventListener('storage', (e) => { if (e.key === KEY) location.reload(); });
}
