// Contract: frontend behaviour the boot.js sync agent and the server adapters rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importUpstream, readUpstream, upstreamPath, memoryStorage, point } from './helpers.mjs';

test('index.html: one <head> anchor, inline theme script, module entry js/app.js', () => {
  const html = readUpstream('public/index.html');
  assert.equal(html.match(/<head>/g)?.length, 1, `${point('html-head')} boot.js is injected right after <head>`);
  const inline = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.match(inline, /localStorage\.getItem\('wickline\.theme'\)/, point('html-head'));
  assert.match(inline, /localStorage\.getItem\('wickline\.paint'\)/, point('html-head'));
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/, point('html-head'));
});

test('store keeps JSON under wickline.<key>', async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    const { store } = await importUpstream('public/js/util.js');
    store.set('contract', { a: 1 });
    assert.equal(storage.getItem('wickline.contract'), '{"a":1}', point('storage-prefix'));
    assert.deepEqual(store.get('contract'), { a: 1 }, point('storage-prefix'));
    assert.equal(store.get('missing', 'fallback'), 'fallback', point('storage-prefix'));
  } finally {
    delete globalThis.localStorage;
  }
});

test('modules that bypass store keep the wickline. prefix', () => {
  assert.match(readUpstream('public/js/drawings.js'), /localStorage\.(get|set)Item\(`wickline\.drawings\.\$\{key\}`/, point('storage-direct'));
  assert.match(readUpstream('public/js/scripts.js'), /const KEY = 'wickline\.scripts';/, point('storage-direct'));
  assert.match(readUpstream('public/js/i18n.js'), /const KEY = 'wickline\.lang';/, point('storage-direct'));
  assert.match(readUpstream('public/js/i18n.js'), /localStorage\.removeItem\(KEY\)/, `${point('storage-direct')} lang deletion must sync as a tombstone`);
});

test('storage event listeners drive live remote apply', () => {
  assert.match(readUpstream('public/js/alerts.js'), /addEventListener\('storage'[\s\S]{0,80}'wickline\.alerts'/, point('storage-listeners'));
  assert.match(readUpstream('public/js/trading.js'), /addEventListener\('storage'[\s\S]{0,80}'wickline\.paper'/, point('storage-listeners'));
  assert.match(readUpstream('public/js/scripts.js'), /addEventListener\('storage'[\s\S]{0,60}e\.key === KEY/, point('storage-listeners'));
  assert.match(readUpstream('public/js/i18n.js'), /addEventListener\('storage'[\s\S]{0,60}e\.key === KEY\) location\.reload\(\)/, point('storage-listeners'));
});

test('URL hash is s=<symbol>&tf=<tf> and overrides the stored active chart', () => {
  const app = readUpstream('public/js/app.js');
  assert.match(app, /new URLSearchParams\(\{ s: a\.symbol, tf: a\.tf \}\)/, point('url-hash'));
  assert.match(app, /applyHash\(w\.charts\[w\.active\], hash\)/, point('url-hash'));
});

test('saved scripts carry id and updated', () => {
  const src = readUpstream('public/js/scripts.js');
  assert.match(src, /Object\.assign\(s, \{ name, code, updated: now \}/, point('scripts-shape'));
  assert.match(src, /id: id \|\| uid\(\), name, code, created: now, updated: now/, point('scripts-shape'));
});

test('crypto feeds: Binance miniTicker streams and the Coinbase ticker feed', () => {
  const src = readUpstream('public/js/datafeed.js');
  assert.match(src, /`\$\{t\.toLowerCase\(\)\}@miniTicker`/, point('crypto-feeds'));
  assert.match(src, /\/stream\?streams=\$\{streams\}/, point('crypto-feeds'));
  assert.match(src, /wss:\/\/data-stream\.binance\.vision/, point('crypto-feeds'));
  assert.match(src, /wss:\/\/fstream\.binance\.com/, point('crypto-feeds'));
  assert.match(src, /const COINBASE_WS = 'wss:\/\/ws-feed\.exchange\.coinbase\.com'/, point('crypto-feeds'));
});

test('PaperAccount exposes the engine API', async () => {
  const { PaperAccount } = await importUpstream('public/js/paper.js');
  for (const m of ['placeOrder', 'cancelOrder', 'closePosition', 'tick', 'bar', 'toJSON']) {
    assert.equal(typeof PaperAccount.prototype[m], 'function', `${point('paper-engine')} ${m}`);
  }
});

test('the keys boot.js applies live are exactly the keys upstream has storage listeners for', async () => {
  const { readdirSync } = await import('node:fs');
  const { clientKeyConfig } = await import('../../sync/key-policy.mjs');
  const listened = new Set();
  for (const f of readdirSync(upstreamPath('public/js')).filter((n) => n.endsWith('.js'))) {
    const src = readUpstream(`public/js/${f}`);
    const constKey = /const KEY = '(wickline\.[\w.]+)'/.exec(src)?.[1];
    // each listener compares e.key with a literal key or the file's KEY constant
    for (const m of src.matchAll(/addEventListener\('storage',[\s\S]{0,200}?e\.key\s*[!=]==\s*('wickline\.([\w.]+)'|KEY\b)/g)) {
      listened.add(m[2] ?? constKey?.slice('wickline.'.length));
    }
  }
  assert.deepEqual([...listened].sort(), [...clientKeyConfig().live].sort(),
    `${point('storage-listeners')} update clientKeyConfig().live: keys in the list apply live, others wait for a reload`);
});
