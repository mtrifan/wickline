// The UI languages: every key in every dictionary with the same {placeholders}, every key
// the app uses exists, and the language detection and t() work. Run: node test/i18n.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import en from '../public/js/lang/en.js';
import zhCN from '../public/js/lang/zh-CN.js';
import ja from '../public/js/lang/ja.js';
import zhTW from '../public/js/lang/zh-TW.js';
import ko from '../public/js/lang/ko.js';
import es from '../public/js/lang/es.js';
import ptBR from '../public/js/lang/pt-BR.js';
import it from '../public/js/lang/it.js';
import de from '../public/js/lang/de.js';
import fr from '../public/js/lang/fr.js';
import { t, lang, langFromLocale, LANGUAGES } from '../public/js/i18n.js';

const root = new URL('../public/', import.meta.url);
const DICTS = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, 'pt-BR': ptBR, it, de, fr };
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

const forms = (v) => (typeof v === 'string' ? [v] : Object.values(v));
const holes = (v) => new Set(forms(v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

ok('LANGUAGES matches the dictionaries', () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id).sort(), Object.keys(DICTS).sort());
});

ok('English has text for every key, and plurals have an "other" form', () => {
  assert.ok(Object.keys(en).length > 500, `only ${Object.keys(en).length} keys`);
  for (const [k, v] of Object.entries(en)) {
    if (typeof v === 'string') assert.ok(v.length, `${k} is empty`);
    else assert.ok(typeof v?.other === 'string' && v.other.length, `${k}: a plural needs "other"`);
  }
});

for (const id of Object.keys(DICTS).filter((x) => x !== 'en')) {
  const d = DICTS[id];
  ok(`${id} has exactly the English keys`, () => {
    const missing = Object.keys(en).filter((k) => !(k in d));
    const extra = Object.keys(d).filter((k) => !(k in en));
    assert.deepEqual(missing, [], `${id} is missing ${missing.length} keys: ${missing.slice(0, 20).join(', ')}`);
    assert.deepEqual(extra, [], `${id} has keys English doesn't: ${extra.slice(0, 20).join(', ')}`);
  });
  ok(`${id} keeps every {placeholder}, and has no empty text`, () => {
    for (const [k, v] of Object.entries(d)) {
      assert.ok(typeof v === 'string' ? v.length : typeof v?.other === 'string' && v.other.length, `${id} ${k} is empty`);
      assert.ok(same(holes(v), holes(en[k])), `${id} ${k}: placeholders {${[...holes(v)]}} vs English {${[...holes(en[k])]}}`);
    }
  });
  ok(`${id} has no English sentences left over`, () => {
    // An untranslated phrase: identical to English and made of several English words (three in the
    // European languages, which share trading terms like "Stop loss" and "Take profit" with English).
    // Indicator names ("Relative Strength Index") are proper names that German keeps in English.
    const words = ['es', 'pt-BR', 'it', 'de', 'fr'].includes(id) ? 3 : 2;
    const phrase = new RegExp(`[a-z]{3,}(?: [a-z]{3,}){${words - 1}}`, 'i');
    const left = Object.keys(d).filter((k) => !/^ind\.\w+\.name$/.test(k) && typeof d[k] === 'string' && d[k] === en[k]
      && phrase.test(d[k].replace(/<[^>]+>|\{\w+\}|https?:\S+/g, '')) && !CJK.test(d[k]));
    assert.deepEqual(left, [], `${id}: ${left.slice(0, 20).join(', ')}`);
  });
}

// Every literal key the app asks for, in the markup and the code.
const used = new Map();
const note = (key, file) => { if (!used.has(key)) used.set(key, file); };
const html = readFileSync(new URL('index.html', root), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria-label)?="([^"]+)"/g)) note(m[1], 'index.html');
for (const f of readdirSync(new URL('js/', root)).filter((x) => x.endsWith('.js'))) {
  const src = readFileSync(new URL(`js/${f}`, root), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*(['"`])([a-zA-Z][\w-]*\.[\w.-]+)\1/g)) note(m[2], f);
}

ok('every key used in index.html and public/js exists', () => {
  assert.ok(used.size > 300, `found only ${used.size} keys in use`);
  const unknown = [...used].filter(([k]) => !(k in en)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(unknown, [], `unknown keys: ${unknown.slice(0, 20).join(', ')}`);
});

ok('t() fills placeholders, picks plurals and falls back to the key', () => {
  assert.equal(lang, 'en'); // Node has no page: always English
  assert.equal(t('common.close'), 'Close');
  assert.equal(t('no.such.key'), 'no.such.key');
  const plural = Object.entries(en).find(([, v]) => typeof v === 'object' && v.one && v.other.includes('{n}'));
  if (plural) {
    const [k, v] = plural;
    assert.equal(t(k, { n: 1 }), v.one.replaceAll('{n}', '1'));
    assert.equal(t(k, { n: 3 }), v.other.replaceAll('{n}', '3'));
  }
});

ok('the system language picks the UI language', () => {
  assert.equal(langFromLocale('zh-CN'), 'zh-CN');
  assert.equal(langFromLocale('zh-Hans-SG'), 'zh-CN');
  assert.equal(langFromLocale('zh-TW'), 'zh-TW');
  assert.equal(langFromLocale('zh-HK'), 'zh-TW');
  assert.equal(langFromLocale('zh-MO'), 'zh-TW');
  assert.equal(langFromLocale('zh-Hant-HK'), 'zh-TW');
  assert.equal(langFromLocale('zh-Hans-HK'), 'zh-CN');
  assert.equal(langFromLocale('zh'), 'zh-CN');
  assert.equal(langFromLocale('ko-KR'), 'ko');
  assert.equal(langFromLocale('es-MX'), 'es');
  assert.equal(langFromLocale('pt-BR'), 'pt-BR');
  assert.equal(langFromLocale('pt-PT'), 'pt-BR');
  assert.equal(langFromLocale('ja-JP'), 'ja');
  assert.equal(langFromLocale('ja'), 'ja');
  assert.equal(langFromLocale('it-IT'), 'it');
  assert.equal(langFromLocale('de-AT'), 'de');
  assert.equal(langFromLocale('fr-CA'), 'fr');
  assert.equal(langFromLocale('en-GB'), 'en');
  assert.equal(langFromLocale('lt-LT'), 'en');
  assert.equal(langFromLocale(undefined), 'en');
});

console.log(`i18n: ${n} checks passed (${Object.keys(en).length} keys, ${used.size} used in the app)`);
