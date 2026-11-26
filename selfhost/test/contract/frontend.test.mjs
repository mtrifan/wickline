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

test('PaperAccount behaves as the server-side paper evaluator relies on', async () => {
  const { PaperAccount } = await importUpstream('public/js/paper.js');
  const P = point('paper-engine');
  const a = new PaperAccount({ balance: 1_000_000 });
  a.tick('X', 100, 1);
  a.placeOrder({ symbol: 'X', side: 'buy', type: 'limit', qty: 1, price: 95, tp: 120 }, { price: 100, time: 1 });
  a.placeOrder({ symbol: 'X', side: 'buy', type: 'limit', qty: 1, price: 93 }, { price: 100, time: 1 });
  assert.equal(a.hasWork('X'), true, `${P} hasWork`);
  // One price can produce several results; times are the seconds passed in.
  const res = a.tick('X', 92, 3);
  assert.equal(res.length, 2, `${P} several results from one price`);
  assert.deepEqual(Object.keys(res[0]).sort(), ['commission', 'id', 'orderId', 'price', 'qty', 'reason', 'side', 'symbol', 'time'], `${P} fill shape`);
  assert.equal(res[0].time, 3, `${P} times are the seconds passed in`);
  assert.equal(res[0].reason, 'Limit', `${P} fill reason`);
  assert.equal(a.tick('X', 125, 4).at(-1).reason, 'Take profit', `${P} bracket exit reason`);
  // A fill that buying power no longer covers is a rejection: no id, the order removed.
  const b = new PaperAccount({ balance: 1_000 });
  b.tick('Y', 10, 1);
  b.placeOrder({ symbol: 'Y', side: 'buy', type: 'limit', qty: 90, price: 9 }, { price: 10, time: 1 });
  b.cash = 10;
  const [rej] = b.tick('Y', 8, 2);
  assert.equal(rej.rejected, true, `${P} rejection`);
  assert.equal(rej.id, undefined, `${P} rejections have no id`);
  assert.equal(b.orders.length, 0, `${P} a rejected order is removed`);
  // toJSON keeps last prices and the shared id counter; caps trades and fills.
  const j = a.toJSON();
  assert.ok(j.last && Number.isInteger(j.seq), `${P} toJSON last and seq`);
  assert.match(readUpstream('public/js/paper.js'), /trades: this\.trades\.slice\(-500\), fills: this\.fills\.slice\(-1000\)/, `${P} toJSON caps`);
  assert.match(readUpstream('public/js/paper.js'), /for \(let guard = 0; guard < 50; guard\+\+\)/, `${P} the walk stops after 50 steps`);
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

test('the alert worker\'s crypto sources use upstream\'s hosts, endpoints and message fields', async () => {
  const src = readUpstream('public/js/datafeed.js');
  const { BINANCE, COINBASE_REST, COINBASE_WS } = await import('../../alerts/sources/crypto.mjs');
  for (const [market, cfg] of Object.entries(BINANCE)) {
    for (const h of [...cfg.rest, ...cfg.ws]) assert.ok(src.includes(`'${h}'`), `${point('crypto-feeds')} ${market} host ${h}`);
    assert.ok(src.includes(`ticker24: '${cfg.ticker24}'`), `${point('crypto-feeds')} ${market} ticker24`);
  }
  assert.ok(src.includes(`const COINBASE_REST = '${COINBASE_REST}'`), point('crypto-feeds'));
  assert.ok(src.includes(`const COINBASE_WS = '${COINBASE_WS}'`), point('crypto-feeds'));
  assert.match(src, /this\.emit\(`\$\{src\}:\$\{d\.s\}`, \+d\.c, \+d\.o\)/, `${point('crypto-feeds')} miniTicker fields s and c`);
  assert.match(src, /if \(m\.type === 'ticker'\) this\.emit\(`COINBASE:\$\{m\.product_id\}`, \+m\.price/, `${point('crypto-feeds')} Coinbase ticker fields`);
  assert.match(src, /\$\{cfg\.ticker24\}\?type=MINI&symbols=/, `${point('crypto-feeds')} spot batch ticker`);
  assert.match(src, /\/products\/\$\{t\}\/stats/, `${point('crypto-feeds')} Coinbase stats (last price)`);
});

test('the alert worker\'s Bybit and OKX sources use upstream\'s hosts, channels and fields', async () => {
  const src = readUpstream('public/js/crypto-exchanges.js');
  const c = await import('../../alerts/sources/crypto.mjs');
  const list = (a) => `[${a.map((h) => `'${h}'`).join(', ')}]`;
  assert.ok(src.includes(`const BYBIT_REST = ${list(c.BYBIT_REST)}`), `${point('crypto-feeds')} Bybit REST hosts`);
  assert.ok(src.includes(`const BYBIT_WS = ${list(c.BYBIT_WS)}`), `${point('crypto-feeds')} Bybit WS hosts`);
  assert.ok(src.includes(`const OKX_REST = ${list(c.OKX_REST)}`), `${point('crypto-feeds')} OKX REST hosts`);
  assert.ok(src.includes(`const OKX_WS = ${list(c.OKX_WS)}`), `${point('crypto-feeds')} OKX WS hosts`);
  assert.match(src, /const bybitCat = \(src\) => \(src === 'BYBITF' \? 'linear' : 'spot'\)/, `${point('crypto-feeds')} Bybit categories`);
  assert.match(src, /\/v5\/public\/\$\{bybitCat\(src\)\}/, `${point('crypto-feeds')} Bybit stream path`);
  assert.match(src, /tickerTopic: \(src, ticker\) => `tickers\.\$\{ticker\}`/, `${point('crypto-feeds')} Bybit tickers topic`);
  assert.match(src, /d\.lastPrice != null \? \+d\.lastPrice/, `${point('crypto-feeds')} Bybit lastPrice (absent on partial updates)`);
  assert.match(src, /ping: \(\) => JSON\.stringify\(\{ op: 'ping' \}\)/, `${point('crypto-feeds')} Bybit ping`);
  assert.match(src, /const okxId = \(src, ticker\) => \(src === 'OKXF' \? `\$\{ticker\}-SWAP` : ticker\)/, `${point('crypto-feeds')} OKX perpetual ids`);
  assert.match(src, /tickerTopic: \(src, ticker\) => \(\{ channel: 'tickers', instId: okxId\(src, ticker\) \}\)/, `${point('crypto-feeds')} OKX tickers channel`);
  assert.match(src, /ticker: d\.instId\.replace\(\/-SWAP\$\/, ''\), last: \+d\.last/, `${point('crypto-feeds')} OKX last price`);
  assert.match(src, /ping: \(\) => 'ping'/, `${point('crypto-feeds')} OKX ping`);
  assert.deepEqual(Object.keys((await importUpstream('public/js/crypto-exchanges.js')).EXCHANGE_SOURCES), ['BYBIT', 'BYBITF', 'OKX', 'OKXF'], `${point('crypto-feeds')} exchange markets`);
  // REST fallback: the same ticker endpoints and price fields upstream reads.
  assert.match(src, /bybitGet\(src, `\/v5\/market\/tickers\?category=\$\{cat\}`\)/, `${point('crypto-feeds')} Bybit REST tickers endpoint`);
  assert.match(src, /const last = \+r\.lastPrice;/, `${point('crypto-feeds')} Bybit REST lastPrice`);
  assert.match(src, /okxGet\(src, `\/api\/v5\/market\/tickers\?instType=\$\{src === 'OKXF' \? 'SWAP' : 'SPOT'\}`\)/, `${point('crypto-feeds')} OKX REST tickers endpoint`);
  assert.match(src, /const last = \+r\.last;/, `${point('crypto-feeds')} OKX REST last`);
});
