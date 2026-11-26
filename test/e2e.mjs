// End-to-end check of the real app in Electron, with live data (needs internet).
// Run: npm run test:e2e
// Opens the app with its built-in server in a hidden window and checks charts for several
// markets, the theme dialog, the Ext button, multi-chart layouts, the network proxy, the UI languages and console errors.
import { app, BrowserWindow, ipcMain, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { setupProxy } from '../desktop/proxy.mjs';
import { startHttpProxy, startSocks5Proxy } from './proxy-servers.mjs';
import { LANGUAGES } from '../public/js/i18n.js';

// One profile per run, so two runs at once don't share (or wipe) each other's storage.
const profile = path.join(os.tmpdir(), `wickline-e2e-profile-${process.pid}`);
rmSync(profile, { recursive: true, force: true });
app.setPath('userData', profile);
// English UI whatever the system language (navigator.language follows this); section 10 switches it.
app.commandLine.appendSwitch('lang', 'en-US');

const CHARTS = [
  ['YAHOO:AAPL', '1D'], ['YAHOO:NVDA', '5m'], ['YAHOO:SPY', '1h'], ['YAHOO:^GSPC', '1W'],
  ['YAHOO:EURUSD=X', '15m'], ['YAHOO:GC=F', '1D'], ['YAHOO:SAP.DE', '1D'],
  ['BINANCE:BTCUSDT', '1m'], ['BINANCEF:ETHUSDT', '4h'], ['COINBASE:BTC-USD', '1D'],
  ['BYBIT:BTCUSDT', '15m'], ['BYBITF:SOLUSDT', '1h'], ['OKX:ETH-USDT', '4h'], ['OKXF:BTC-USDT', '1D'], ['YAHOO:USDJPY=X', '1D'],
];

let failed = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  results.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  console.log(results.at(-1));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1' });
  // Like the app: the proxy setting (desktop/proxy.mjs) and the preload the page reaches it through.
  const origin = `http://127.0.0.1:${port}`;
  await setupProxy({ ses: session.defaultSession, ipcMain, dir: profile, isAppUrl: (u) => { try { return new URL(u).origin === origin; } catch { return false; } } }).ready;
  const preload = fileURLToPath(new URL('../desktop/preload.cjs', import.meta.url));
  const win = new BrowserWindow({ width: 1400, height: 860, show: false, webPreferences: { backgroundThrottling: false, preload } });
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = e?.level ?? level, msg = String(e?.message ?? message);
    // Dropped network connections (e.g. a live stream closed on navigation) aren't app errors.
    if ((lvl === 'error' || lvl === 3) && !/Failed to load resource|ERR_CONNECTION|ERR_ABORTED/.test(msg)) errors.push(msg.slice(0, 200));
  });
  // A script interrupted by a navigation never answers: fail then, rather than wait forever.
  const run = (js) => Promise.race([win.webContents.executeJavaScript(js),
    wait(60000).then(() => { throw new Error(`no answer from the page: ${js.slice(0, 80)}`); })]);
  let page = 0;
  const open = async (sym, tf) => {
    // A new query string forces a fresh page (a different #hash alone wouldn't reload it).
    // ?e2e exposes the charts to this test as window.__wickline.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}#s=${encodeURIComponent(sym)}&tf=${tf}`);
    for (let i = 0; i < 40; i++) {
      await wait(500);
      const done = await run(`(() => { const c = document.querySelector('.cell'); if (!c) return false;
        if (!c.querySelector('.overlay.error').hidden) return true;
        return !!c.querySelector('.lg-ohlc')?.innerText.trim() && /\\d/.test(document.title); })()`);
      if (done) break;
    }
    return run(`(() => { const c = document.querySelector('.cell');
      return { legend: c.querySelector('.lg-ohlc')?.innerText.replace(/\\s+/g, ' ').trim(),
        title: c.querySelector('.lg-title')?.innerText.replace(/\\s+/g, ' ').trim(),
        error: c.querySelector('.overlay.error').hidden ? null : c.querySelector('.overlay.error').innerText.replace(/\\s+/g, ' ').slice(0, 120),
        mode: document.body.dataset.mode, tabTitle: document.title }; })()`);
  };

  try {
    // 1. Charts for every kind of market and several timeframes.
    for (const [sym, tf] of CHARTS) {
      const r = await open(sym, tf);
      // The chart must be the one asked for, not a leftover from the previous page.
      const want = sym.split(':')[1].replace(/=X|=F|-USD\b|\.DE|\^/g, '').replace(/[^A-Z]/g, '').slice(0, 4);
      const titled = (r.title || '').toUpperCase().replace(/[^A-Z]/g, '').includes(want);
      check(`${sym} ${tf} loads`, !r.error && titled && /^O\S+ H\S+ L\S+ C\S+/.test(r.legend || ''),
        r.error || `${(r.title || '').slice(0, 36)} | ${(r.legend || '').slice(0, 44)}`);
    }
    // Daily forex (the last chart opened): Yahoo's closes are rebuilt, so the candles have bodies.
    const fx = await run(`(() => { const b = window.__wickline.views()[0].bars.slice(-60, -1); return { n: b.length, flat: b.filter((x) => Math.abs(x.close - x.open) < 0.05 * (x.high - x.low)).length }; })()`);
    check('daily forex candles have real bodies', fx.n > 40 && fx.flat < fx.n * 0.2, JSON.stringify(fx));
    // Issue #7: scrolled back, the » button shows; it brings the newest candle back.
    const latest = await run(`(async () => { const v = window.__wickline.views()[0]; const ts = v.chart.timeScale(); const r = ts.getVisibleLogicalRange();
      ts.setVisibleLogicalRange({ from: r.from - 400, to: r.to - 400 }); await new Promise((ok) => setTimeout(ok, 1500));
      const btn = v.el.querySelector('.to-latest'); const shown = !btn.hidden; btn.click(); await new Promise((ok) => setTimeout(ok, 1200));
      return { shown, back: ts.getVisibleLogicalRange().to >= v.bars.length - 2, hiddenAfter: btn.hidden }; })()`);
    check('the » button brings back the latest candle', latest.shown && latest.back && latest.hiddenAfter, JSON.stringify(latest));
    // Issue #6: a drawing's exact prices and dates, and a label.
    const edit = await run(`(async () => { const v = window.__wickline.views()[0]; const b = v.bars, n = b.length;
      v.drawings.items.push({ id: 'e2e-ed', type: 'trend', color: '#4FA3F7', p1: { time: b[n - 30].time, price: b[n - 30].close }, p2: { time: b[n - 3].time, price: b[n - 3].close } });
      v.drawings.select('e2e-ed'); document.querySelector('.draw-bar [data-db="edit"]').click(); await new Promise((ok) => setTimeout(ok, 200));
      const ed = document.querySelector('.point-editor'); const price = ed.querySelector('[data-key="p2"] [data-pe="price"]'); price.value = '123.25'; price.dispatchEvent(new Event('change', { bubbles: true }));
      const label = ed.querySelector('[data-pe="label"]'); label.value = 'e2e'; label.dispatchEvent(new Event('change', { bubbles: true }));
      const d = v.drawings.items.find((x) => x.id === 'e2e-ed'); const fields = ed.querySelectorAll('input').length; ed.querySelector('[data-pe="done"]').click(); v.drawings.deleteSelected();
      return { open: !!ed, fields, price: d.p2.price, label: d.label, closed: ed.hidden }; })()`);
    check('the point editor sets a drawing\'s exact price and its label', edit.fields === 5 && edit.price === 123.25 && edit.label === 'e2e' && edit.closed, JSON.stringify(edit));
    // Bybit and OKX: in the symbol search and as whole markets.
    const exch = await run(`import('./js/datafeed.js').then(async (m) => ({ search: [...new Set((await m.searchCrypto('SOL')).map((r) => r.full.split(':')[0]))],
      markets: Object.fromEntries(await Promise.all(['bybit', 'bybitf', 'okx', 'okxf'].map(async (id) => [id, (await m.loadUniverse(id)).length]))) }))`);
    check('symbol search finds Bybit and OKX spot and perpetuals', ['BYBIT', 'BYBITF', 'OKX', 'OKXF'].every((x) => exch.search.includes(x)), exch.search.join(','));
    check('Markets can list all of Bybit and OKX', Object.values(exch.markets).every((n) => n > 100), JSON.stringify(exch.markets));
    const first = await open('YAHOO:AAPL', '1D');
    check('desktop data mode uses the built-in server', first.mode === 'server', first.mode);
    check('tab title shows symbol and price', /^AAPL [\d,.]+ [▲▼]/.test(first.tabTitle), first.tabTitle);
    // The Twelve Data key is only for the static website; the desktop app shouldn't ask for one.
    await run(`document.querySelector('#settings-btn').click()`);
    await wait(300);
    const dlg = await run(`({ key: document.querySelector('#set-td-key').offsetParent !== null, text: document.querySelector('#set-mode').innerText })`);
    check('Data sources asks for no API key in the desktop app', !dlg.key && /no API key/.test(dlg.text), dlg.text.split('.')[0]);
    await run(`document.querySelector('#settings-modal .close').click()`);

    // 2. Markets panel lists all US stocks.
    await run(`document.querySelector('.side-tabs [data-tab="markets"], .side-tabs button:nth-child(2)')?.click()`);
    await wait(3000);
    const count = await run(`document.querySelector('#mk-count')?.textContent || ''`);
    check('Markets panel lists thousands of US stocks', Number(count.replace(/\D/g, '')) > 5000, count);
    // 2b. Watchlist: sections and drag to reorder (issue #3), saved across restarts.
    await run(`document.querySelector('.side-tabs [data-tab="watchlist"]').click()`);
    await wait(300);
    const wlOrder = () => run(`[...document.querySelectorAll('#wl-rows .wl-row, #wl-rows .wl-sec')].map((r) => (r.dataset.sec ? '§' + r.dataset.sec : r.dataset.sym) + (r.hidden ? '(hidden)' : ''))`);
    const wlDrag = (fromSel, toSel, below) => run(`(() => {
      const list = document.querySelector('#wl-rows'), from = document.querySelector('${fromSel}'), to = document.querySelector('${toSel}');
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect(), y = ${below} ? b.bottom - 3 : b.top + 3;
      const ev = (type, el, cy) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1, clientX: a.left + 40, clientY: cy }));
      ev('pointerdown', from.querySelector('.wl-sym, .wl-sec-name'), a.top + a.height / 2);
      ev('pointermove', list, a.top + a.height / 2 + 8); ev('pointermove', list, y); ev('pointerup', list, y);
    })()`);
    const wl0 = await wlOrder();
    await run(`document.querySelector('#wl-sec-add').click()`);
    await wait(200);
    await run(`(() => { const i = document.querySelector('.wl-sec-input'); i.value = 'Crypto'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await wait(200);
    const wlBtc = '#wl-rows .wl-row[data-sym="BINANCE:BTCUSDT"]';
    await wlDrag(wlBtc, '#wl-rows .wl-sec', true);
    await wait(200);
    const wl1 = await wlOrder();
    check('watchlist sections: add one, drag a symbol into it', wl1.at(-2) === '§Crypto' && wl1.at(-1) === 'BINANCE:BTCUSDT' && wl1.length === wl0.length + 1, wl1.slice(-3).join(' '));
    await run(`document.querySelector('#wl-rows .wl-sec .wl-sec-toggle').click()`);
    await wait(200);
    const wlSaved = JSON.parse(await run(`localStorage.getItem('wickline.watchlist')`));
    check('a section collapses, and the order is saved', (await wlOrder()).at(-1) === 'BINANCE:BTCUSDT(hidden)' && wlSaved.at(-2) === '§Crypto', wlSaved.slice(-2).join(' '));
    await run(`document.querySelector('#wl-rows .wl-sec .wl-sec-toggle').click()`);
    await wait(200);
    await wlDrag(wlBtc, '#wl-rows .wl-row[data-i="0"]', false);
    await wait(200);
    await run(`document.querySelector('#wl-rows .wl-sec .wl-sec-del').click()`);
    await wait(200);
    const wl2 = await wlOrder();
    check('drag back to the top; deleting the section keeps its symbols', JSON.stringify(wl2) === JSON.stringify(wl0), wl2.slice(0, 3).join(' '));
    await run(`document.querySelector('.side-tabs [data-tab="markets"]').click()`);

    // 3. Theme dialog: presets and custom colors change the page.
    const accent = () => run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    const before = await accent();
    await run(`document.querySelector('#appearance-btn').click(); document.querySelector('[data-preset="ember"]').click()`);
    await wait(500);
    check('choosing a preset changes the colors', (await accent()) !== before && (await accent()).toUpperCase() === '#F2A33A', await accent());
    await run(`(() => { const i = document.querySelector('[data-key="accent"]'); i.value = '#123456';
      i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await wait(500);
    check('a custom accent color applies', (await accent()).toUpperCase() === '#123456', await accent());
    await run(`document.querySelector('#appear-reset').click(); document.querySelector('[data-preset="crimson"]').click(); document.querySelector('.appear-done').click()`);
    await wait(300);
    check('reset returns to the default theme', (await accent()).toUpperCase() === '#E5484D', await accent());

    // 4. Ext button: only for stocks on intraday charts.
    const extHidden = () => run(`document.querySelector('#ext-btn').hidden`);
    await open('YAHOO:AAPL', '5m');
    check('Ext button shows on an intraday stock chart', (await extHidden()) === false);
    await open('YAHOO:AAPL', '1D');
    check('Ext button hides on a daily chart', (await extHidden()) === true);
    await open('BINANCE:BTCUSDT', '5m');
    check('Ext button hides for crypto', (await extHidden()) === true);

    // 5. After the user drags the price axis (which turns auto-scaling off), the next symbol still
    //    opens on its latest bars with its prices in view, not into empty space.
    await open('YAHOO:AAPL', '1h');
    const box = await run(`(() => { const r = window.__wickline.views()[0].chartEl.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    const ax = box.x + box.w - 25;
    mouse('mouseDown', ax, box.y + box.h * 0.3);
    for (let s = 1; s <= 12; s++) { mouse('mouseMove', ax, box.y + box.h * (0.3 + 0.025 * s)); await wait(16); }
    mouse('mouseUp', ax, box.y + box.h * 0.6);
    await wait(500);
    const dragged = await run(`window.__wickline.views()[0].main.priceScale().options().autoScale`);
    check('dragging the price axis turns auto-scaling off (test setup)', dragged === false);
    await run(`window.__wickline.views()[0].setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 40; i++) { // until BTC's data is on the chart
      await wait(500);
      if (await run(`(() => { const v = window.__wickline.views()[0]; return !!v.feed && v.q('.overlay.loading').hidden && v.bars.at(-1)?.close > 1000; })()`)) break;
    }
    await wait(800);
    const view = await run(`(() => { const v = window.__wickline.views()[0]; const n = v.bars.length;
      const lr = v.chart.timeScale().getVisibleLogicalRange(); const last = v.bars[n - 1];
      const top = v.main.coordinateToPrice(5), bot = v.main.coordinateToPrice(v.chartEl.clientHeight * 0.5);
      return { n, to: lr.to, last: last.close, top, bot, auto: v.main.priceScale().options().autoScale }; })()`);
    check('a new symbol opens on its latest bars', view.to >= view.n - 1 && view.to <= view.n + 15, `view ends at ${Math.round(view.to)} of ${view.n}`);
    check('a new symbol opens with its prices in view', view.auto && view.last <= view.top && view.last >= Math.min(view.bot, view.top) - Math.abs(view.top) * 0.5,
      `last ${view.last} scale ${Math.round(view.bot)}..${Math.round(view.top)}`);

    // 5b. Any timeframe: built from each source's own intervals, live too; the
    //     ▾ menu with stars; typing a number opens "Change interval".
    // Bar spacing, and bars off their day's grid (midnight UTC for crypto, the day's first bar for stocks).
    const tfBars = (sec) => run(`(() => { const v = window.__wickline.views()[0]; const b = v.bars;
      const gaps = {}; for (let i = 1; i < b.length; i++) { const g = b[i].time - b[i - 1].time; gaps[g] = (gaps[g] || 0) + 1; }
      const first = {}; for (const x of b) { const d = Math.floor(x.time / 86400); if (!(d in first)) first[d] = x.time; }
      return { n: b.length, common: +Object.entries(gaps).sort((x, y) => y[1] - x[1])[0]?.[0], tf: v.state.tf, status: v.status,
        offGrid: b.filter((x) => (x.time - first[Math.floor(x.time / 86400)]) % ${sec}).length, legend: v.q('.lg-meta').textContent }; })()`);
    const waitTf = async (tf) => {
      for (let i = 0; i < 40; i++) {
        await wait(400);
        if (await run(`(() => { const v = window.__wickline.views()[0]; return v.state.tf === '${tf}' && !!v.feed && v.bars.length > 0 && v.q('.overlay.loading').hidden; })()`)) return;
      }
    };
    await open('BINANCE:BTCUSDT', '10m');
    const b10 = await tfBars(600);
    check('Binance 10m (from 5m klines): 10-minute bars on the exchange\'s grid', b10.n >= 900 && b10.common === 600 && b10.offGrid === 0 && /^10m/.test(b10.legend), JSON.stringify(b10));
    check('...shown as the active timeframe though it isn\'t a favourite', await run(`!!document.querySelector('#tf-group .tf-extra.on[data-tf="10m"]')`));
    const live10 = await run(`(async () => { const v = window.__wickline.views()[0]; const tz = v.meta.tzOffset || 0; const start = v.bars.at(-1).time - tz;
      const k = await (await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=2&startTime=' + start * 1000)).json();
      await new Promise((r) => setTimeout(r, 3000));
      const b = v.bars.find((x) => x.time - tz === start);
      return { status: v.status, open: b.open, high: b.high, low: b.low, rest: { open: +k[0][1], high: Math.max(...k.map((x) => +x[2])), low: Math.min(...k.map((x) => +x[3])) } }; })()`);
    check('...its newest candle is built live from the 5m klines', live10.status === 'live' && live10.open === live10.rest.open
      && live10.high >= live10.rest.high && live10.low <= live10.rest.low, JSON.stringify(live10));
    await open('YAHOO:AAPL', '2m');
    const y2 = await tfBars(120);
    check('a Yahoo stock on 2m: 2-minute bars', y2.n > 1000 && y2.common === 120 && y2.offGrid <= 1 && /^2m/.test(y2.legend), JSON.stringify(y2));
    await open('YAHOO:AAPL', '90m');
    const y90 = await tfBars(5400);
    check('...and on 90m: 90-minute bars from each session\'s start', y90.n > 100 && y90.common === 5400 && y90.offGrid <= 1 && /^90m/.test(y90.legend), JSON.stringify(y90));
    // Typing on the chart: real key presses.
    await open('BINANCE:BTCUSDT', '1h');
    const key = (k) => { for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: k }); };
    key('4'); await wait(100); key('5'); await wait(300);
    const ivl = await run(`({ open: !document.querySelector('.ivl-box').hidden, text: document.querySelector('.ivl-input').value,
      meaning: document.querySelector('.ivl-meaning').innerText.replace(/\\s+/g, ' '), search: document.querySelector('#search-modal').hidden })`);
    check('typing 45 on the chart opens "Change interval" and says what it means', ivl.open && ivl.text === '45' && /45 minutes/.test(ivl.meaning) && ivl.search, JSON.stringify(ivl));
    key('Enter');
    await waitTf('45m');
    const b45 = await tfBars(2700);
    check('...Enter switches the active chart to 45m', b45.tf === '45m' && b45.common === 2700 && b45.offGrid === 0 && (await run(`document.querySelector('.ivl-box').hidden`)), JSON.stringify(b45));
    check('...and the header shows it as active', await run(`!!document.querySelector('#tf-group .tf.on[data-tf="45m"]')`));
    key('7');
    await wait(200);
    await run(`(() => { const i = document.querySelector('.ivl-input'); i.value = '7203.T'; i.dispatchEvent(new Event('input')); })()`);
    const digitTicker = await run(`({ meaning: document.querySelector('.ivl-meaning').innerText, row: document.querySelector('.ivl-search').innerText.replace(/\\s+/g, ' ') })`);
    key('Enter');
    await wait(400);
    const sr = await run(`({ open: !document.querySelector('#search-modal').hidden, q: document.querySelector('#search-input').value, tf: window.__wickline.views()[0].state.tf })`);
    check('a ticker starting with a digit (7203.T) goes on to symbol search', /Not a timeframe/.test(digitTicker.meaning) && /Search symbols for .7203\.T/.test(digitTicker.row)
      && sr.open && sr.q === '7203.T' && sr.tf === '45m', JSON.stringify({ ...digitTicker, ...sr }));
    await run(`document.querySelector('#search-modal .close').click()`);
    // The ▾ menu: groups, a star adds a header button, a row switches the chart.
    await run(`document.querySelector('#tf-group [data-tf-menu]').click()`);
    await wait(200);
    const tfMenu = await run(`({ open: !document.querySelector('#tf-menu').hidden, groups: [...document.querySelectorAll('#tf-menu .menu-title')].map((e) => e.textContent).join(),
      rows: document.querySelectorAll('#tf-menu [data-pick]').length, on: document.querySelector('#tf-menu .tf-row.on')?.dataset.pick })`);
    check('the ▾ menu lists minutes, hours and days', tfMenu.open && tfMenu.groups.startsWith('Minutes,Hours,Days') && tfMenu.rows >= 18 && tfMenu.on === '45m', JSON.stringify(tfMenu));
    await run(`document.querySelector('#tf-menu [data-star="3h"]').click()`);
    await wait(200);
    check('...its star adds a timeframe to the header', await run(`!!document.querySelector('#tf-group [data-tf="3h"]') && document.querySelector('#tf-menu [data-star="3h"]').classList.contains('on')
      && !document.querySelector('#tf-menu').hidden && JSON.parse(localStorage.getItem('wickline.tfFavorites')).includes('3h')`));
    await run(`document.querySelector('#tf-menu [data-pick="2m"]').click()`);
    await waitTf('2m');
    check('...and a row switches the chart', (await run(`window.__wickline.views()[0].state.tf`)) === '2m' && (await run(`document.querySelector('#tf-menu').hidden`)));
    const tfFit = await run(`(async () => { const t = document.querySelector('.topbar'); const bad = [];
      for (const w of [1280, 1366]) { t.style.width = w + 'px'; let fit = false;
        for (let k = 0; k < 20 && !fit; k++) { await new Promise((r) => setTimeout(r, 100)); fit = t.scrollWidth <= t.clientWidth; }
        if (!fit) bad.push(w); }
      t.style.width = ''; return bad; })()`);
    check('...the header still fits with an extra favourite and a non-favourite timeframe', tfFit.length === 0, tfFit.join(', '));
    await run(`localStorage.removeItem('wickline.tfFavorites')`);
    await open('BINANCE:BTCUSDT', '1h'); // as section 5 left it

    // 6. Update notice: a newer release on GitHub (faked here) shows a notice that can be dismissed.
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}`);
    await run(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('api.github.com')
      ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/keptaduona/wickline/releases/tag/v99.0.0', draft: false, prerelease: false }), { status: 200 }))
      : real(u, o); })()`);
    await wait(7000);
    const upd = await run(`({ hidden: document.querySelector('#update').hidden, text: document.querySelector('#update-link').textContent, href: document.querySelector('#update-link').href })`);
    check('update notice shows a newer release', !upd.hidden && /99\.0\.0/.test(upd.text) && /releases\/tag\/v99/.test(upd.href), upd.text);
    await run(`document.querySelector('#update-dismiss').click()`);
    check('dismissing hides the notice', (await run(`document.querySelector('#update').hidden`)) === true);

    // 7. A 4-chart layout renders every chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="4"]').click()`);
    await wait(8000);
    const legends = await run(`[...document.querySelectorAll('.cell .lg-ohlc')].map((e) => e.innerText.trim()).filter(Boolean).length`);
    check('4-chart layout shows 4 charts with data', legends === 4, `${legends} of 4`);

    // 8. Sync across charts (Layout menu): symbol and timeframe, in the layout and in pop-outs.
    const symbols = () => run(`window.__wickline.views().map((v) => v.state.symbol)`);
    const tfs = () => run(`window.__wickline.views().map((v) => v.state.tf)`);
    const active = (js) => run(`(() => { const v = window.__wickline.views().find((x) => x.el.classList.contains('active')); ${js} })()`);
    const toggleSync = async (kind) => {
      await run(`document.querySelector('#layout-btn').click()`);
      await wait(200);
      await run(`document.querySelector('[data-sync="${kind}"]').click(); document.querySelector('#layout-btn').click()`);
      await wait(500);
    };
    check('charts start with their own symbols', new Set(await symbols()).size > 1, (await symbols()).join(', '));
    const pop = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
    await pop.loadURL(`http://127.0.0.1:${port}/?popout=1&e2e#s=${encodeURIComponent('YAHOO:MSFT')}&tf=1D`);
    await wait(2500);
    const popSymbol = () => pop.webContents.executeJavaScript(`window.__wickline.views()[0].state.symbol`);
    await toggleSync('symbol');
    const activeSym = await active('return v.state.symbol;');
    const all = await symbols();
    check('turning symbol sync on puts every chart on the active symbol', all.every((s) => s === activeSym), all.join(', '));
    await active(`v.setSymbol('YAHOO:NVDA');`);
    await wait(1500);
    const afterChange = await symbols();
    check('a new symbol on the active chart goes to every chart', afterChange.every((s) => s === 'YAHOO:NVDA'), afterChange.join(', '));
    check('...and to pop-out windows', (await popSymbol()) === 'YAHOO:NVDA', await popSymbol());
    await pop.webContents.executeJavaScript(`window.__wickline.views()[0].setSymbol('BINANCE:ETHUSDT')`);
    await wait(1500);
    check('a pop-out window can lead too', (await symbols()).every((s) => s === 'BINANCE:ETHUSDT'), (await symbols()).join(', '));
    await toggleSync('interval');
    await active(`v.setTimeframe('15m');`);
    await wait(1500);
    check('timeframe sync changes every chart', (await tfs()).every((t) => t === '15m'), (await tfs()).join(', '));
    check('the Layout button shows that charts are synced', await run(`!!document.querySelector('#layout-btn .sync-dot')`));
    await toggleSync('symbol');
    await toggleSync('interval');
    await active(`v.setSymbol('YAHOO:AAPL'); v.setTimeframe('1D');`);
    await wait(1500);
    const sOff = await symbols(), tOff = await tfs();
    check('with sync off, only the active chart changes', sOff.filter((s) => s === 'YAHOO:AAPL').length === 1 && tOff.filter((t) => t === '1D').length === 1,
      `${sOff.join(', ')} | ${tOff.join(', ')}`);
    pop.destroy();

    // 8b. 8 charts, and resizing the panes by dragging the dividers between them.
    const loaded = () => run(`[...document.querySelectorAll('#charts > .cell .lg-ohlc')].filter((e) => /\\d/.test(e.innerText)).length`);
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('#layout-menu [data-layout="8"]').click()`);
    for (let i = 0; i < 50 && (await loaded()) < 8; i++) await wait(500);
    const cells8 = await run(`document.querySelectorAll('#charts > .cell').length`);
    check('8-chart layout shows 8 charts with data', cells8 === 8 && (await loaded()) === 8, `${await loaded()} of ${cells8} loaded`);
    await run(`document.querySelectorAll('#charts > .cell')[6].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    const act8 = await run(`[...document.querySelectorAll('#charts > .cell')].map((c) => c.classList.contains('active'))`);
    check('...clicking one makes it the only active chart', act8.filter(Boolean).length === 1 && act8[6], act8.join(','));
    const rects = () => run(`[...document.querySelectorAll('#charts > .cell')].map((c) => { const r = c.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; })`);
    // Synthesised pointer events on a divider ('0.0' splits the rows, '1.0' is the first one in the top row).
    const drag = (id, dx, dy) => run(`(() => { const s = document.querySelector('#charts .split[data-split="${id}"]'); const r = s.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const ev = (type, k) => s.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
        button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + ${dx} * k, clientY: y + ${dy} * k }));
      ev('pointerdown', 0); for (let k = 1; k <= 10; k++) ev('pointermove', k / 10); ev('pointerup', 1); })()`);
    const near = (a, b) => Math.abs(a - b) <= 3;
    const same = (a, b) => a.length === b.length && a.every((r, i) => near(r.w, b[i].w) && near(r.h, b[i].h));
    const eq8 = await rects();
    const plotW = () => run(`window.__wickline.views().map((v) => v.chart.timeScale().width())`);
    const plot0 = await plotW();
    check('the dividers show which way they resize', await run(`(() => { const c = (a) => getComputedStyle(document.querySelector('#charts .split[data-axis="' + a + '"]')).cursor;
      return document.querySelectorAll('#charts .split').length === 7 && c('x') === 'col-resize' && c('y') === 'row-resize'; })()`));
    await drag('1.0', 80, 0);
    await drag('0.0', 0, 90);
    await wait(600);
    const moved8 = await rects();
    check('dragging a divider resizes the panes on either side', near(moved8[0].w, eq8[0].w + 80) && near(moved8[1].w, eq8[1].w - 80) && near(moved8[2].w, eq8[2].w) && near(moved8[4].w, eq8[4].w),
      `${eq8.slice(0, 5).map((r) => r.w).join(',')} -> ${moved8.slice(0, 5).map((r) => r.w).join(',')}`);
    check('...and a row divider resizes the rows', near(moved8[0].h, eq8[0].h + 90) && near(moved8[7].h, eq8[7].h - 90), `${eq8[0].h},${eq8[7].h} -> ${moved8[0].h},${moved8[7].h}`);
    // Charts resize on the next frame after their pane does; give a busy machine up to 3 s.
    let plot1 = await plotW();
    for (let k = 0; k < 15 && !(plot1[0] > plot0[0] + 50 && plot1[1] < plot0[1] - 50); k++) { await wait(200); plot1 = await plotW(); }
    check('...and the charts redraw at their new size', plot1[0] > plot0[0] + 50 && plot1[1] < plot0[1] - 50, `${plot0.slice(0, 2)} -> ${plot1.slice(0, 2)}`);
    await drag('1.0', -2000, 0);
    const min8 = await rects();
    check('a pane stops at its minimum size', min8[0].w >= 155 && min8[0].w <= 170, `${min8[0].w}px`);
    await drag('1.0', eq8[0].w + 80 - min8[0].w, 0);
    const savedSizes = await run(`localStorage.getItem('wickline.layoutSizes')`);
    const beforeReload = await rects();
    await win.loadURL(`http://127.0.0.1:${port}/?e2e&page=${++page}`);
    for (let i = 0; i < 20; i++) { await wait(500); if ((await run(`document.querySelectorAll('#charts > .cell').length`)) === 8) break; }
    await wait(800);
    const reloaded = await rects();
    check('pane sizes are kept after a restart', !!savedSizes && near(beforeReload[0].w, eq8[0].w + 80) && same(reloaded, beforeReload),
      `${beforeReload.slice(0, 2).map((r) => `${r.w}×${r.h}`)} -> ${reloaded.slice(0, 2).map((r) => `${r.w}×${r.h}`)}`);
    const dbl = (id) => run(`document.querySelector('#charts .split[data-split="${id}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await dbl('1.0');
    await wait(300);
    const reset1 = await rects();
    check('double-clicking a divider makes that split equal again', reset1.slice(0, 4).every((r, i) => near(r.w, eq8[i].w)) && near(reset1[0].h, reloaded[0].h),
      reset1.slice(0, 4).map((r) => r.w).join(','));
    await dbl('0.0');
    await wait(300);
    check('...and the rows too', same(await rects(), eq8), (await rects()).slice(0, 5).map((r) => `${r.w}×${r.h}`).join(' '));
    await run(`document.querySelectorAll('#charts > .cell')[5].querySelector('[data-cell="max"]').click()`);
    await wait(300);
    const shown = () => run(`(() => { const c = document.querySelector('#charts'), b = c.getBoundingClientRect(), m = c.querySelectorAll('.cell')[5].getBoundingClientRect();
      return { cells: [...c.querySelectorAll('.cell')].filter((x) => x.offsetParent).length, splits: [...c.querySelectorAll('.split')].filter((x) => x.offsetParent).length,
        full: Math.abs(m.width - b.width) < 2 && Math.abs(m.height - b.height) < 2 }; })()`);
    const mx = await shown();
    check('maximizing one of 8 charts fills the chart area, without dividers', mx.cells === 1 && mx.splits === 0 && mx.full, JSON.stringify(mx));
    await run(`document.querySelectorAll('#charts > .cell')[5].querySelector('[data-cell="max"]').click()`);
    await wait(300);
    const rs = await shown();
    check('...and restoring brings back all 8 and their dividers', rs.cells === 8 && rs.splits === 7, JSON.stringify(rs));
    // Going from 8 live charts to 1 disposes 7 of them mid-redraw; none may throw ("Object is disposed").
    const errorsBefore1 = errors.length;
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('#layout-menu [data-layout="1"]').click()`);
    await wait(1200);
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('#layout-menu [data-layout="8"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(500); if ((await run(`document.querySelectorAll('#charts > .cell').length`)) === 8) break; }
    await wait(800);
    check('going from 8 charts to 1 and back throws no errors', errors.length === errorsBefore1, errors.slice(errorsBefore1, errorsBefore1 + 2).join(' | '));
    await run(`document.querySelector('#ed-btn').click()`);
    await wait(500);
    const ed = await run(`(() => { const c = document.querySelector('#charts').getBoundingClientRect(), e = document.querySelector('#editor').getBoundingClientRect();
      const cells = [...document.querySelectorAll('#charts > .cell')].map((x) => x.getBoundingClientRect());
      return { open: e.height > 100, inside: cells.every((r) => r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.bottom <= e.top + 1), half: Math.abs(cells[4].top - c.top - c.height / 2) < 3 }; })()`);
    check('a panel at the bottom shrinks all 8 panes', ed.open && ed.inside && ed.half, JSON.stringify(ed));
    await run(`document.querySelector('#ed-btn').click()`);
    await wait(300);

    // 9. Screener: scans US stocks, ideas sort and filter, a row opens its chart.
    await run(`document.querySelector('#layout-btn').click(); document.querySelector('[data-layout="1"]').click()`);
    await wait(1500);
    await run(`document.querySelector('#sc-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.sc-table tbody tr')`)) break; }
    const scInfo = await run(`({ rows: document.querySelectorAll('.sc-table tbody tr').length, insights: document.querySelector('.sc-insights')?.innerText || '' })`);
    check('screener loads stocks with market insights', scInfo.rows > 10 && /up/.test(scInfo.insights) && /down/.test(scInfo.insights), `${scInfo.rows} rows`);
    await run(`document.querySelector('[data-idea="gainers"]').click()`);
    await wait(300);
    const gains = await run(`[...document.querySelectorAll('.sc-table tbody tr')].slice(0, 15).map((r) => parseFloat(r.children[2].textContent.replace('−', '-')))`);
    check('"Top gainers" lists rising stocks, biggest first', gains.length > 0 && gains.every((g, k) => g > 0 && (k === 0 || g <= gains[k - 1])), gains.slice(0, 5).join(', '));
    const scSym = await run(`(() => { const tr = document.querySelector('.sc-table tbody tr[data-row="1"]'); tr.click(); return tr.querySelector('.sc-sym b').textContent; })()`);
    let scChart = '';
    for (let i = 0; i < 30; i++) { await wait(500); scChart = await run(`document.querySelector('.cell .lg-title').innerText`); if (scChart.startsWith(scSym + ' ')) break; }
    check('clicking a screener row opens that stock', scChart.startsWith(scSym + ' '), `${scSym} -> ${scChart.split('\n')[0]}`);
    // Another market: Japan's largest stocks, with local codes (7203, not 7203.T) and caps in yen.
    await run(`(() => { const s = document.querySelector('#screener [data-f="market"]'); s.value = 'JP'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 90; i++) { await wait(500); if (await run(`!!document.querySelector('.sc-table tbody tr') && /7203|\\d{4}/.test(document.querySelector('.sc-sym b')?.textContent || '')`)) break; }
    await run(`document.querySelector('[data-idea="all"]').click()`);
    await wait(300);
    const jp = await run(`({ rows: document.querySelectorAll('.sc-table tbody tr').length, codes: [...document.querySelectorAll('.sc-sym b')].slice(0, 5).map((b) => b.textContent),
      cap: document.querySelector('.sc-table tbody tr')?.children[5].textContent || '', sub: document.querySelector('.sc-sub').textContent })`);
    check('screener switches to another market (Japan: local codes, caps in yen)', jp.rows > 50 && jp.codes.every((c) => /^\d{4}$/.test(c)) && /¥|JP/.test(jp.cap) && !/US/.test(jp.sub), JSON.stringify(jp));
    const jpSym = await run(`(() => { const tr = document.querySelector('.sc-table tbody tr[data-row="0"]'); tr.click(); return tr.querySelector('.sc-sym b').textContent; })()`);
    await wait(3000);
    const jpChart = await run(`document.querySelector('.cell .lg-title').innerText`);
    check('a Japanese row opens its Tokyo chart', jpChart.split('\n')[0].startsWith(`${jpSym}.T`), `${jpSym} -> ${jpChart.split('\n')[0]}`);
    await run(`(() => { const s = document.querySelector('#screener [data-f="market"]'); s.value = 'us'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await run(`document.querySelector('#sc-close').click()`);

    // 10. Symbol search: one box for every source, and each result says where its data comes from.
    const search = async (q) => {
      await run(`(() => { const i = document.querySelector('#search-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
      let rows = [];
      for (let i = 0; i < 20; i++) {
        await wait(500);
        rows = await run(`[...document.querySelectorAll('#search-results .sr-row')].map((r) => ({ t: r.querySelector('.sr-ticker').textContent, src: r.querySelector('.sr-badge')?.textContent }))`);
        if (i >= 4 && rows.some((r) => r.src === 'Yahoo')) break;
        // Yahoo throttles bursts (this suite sends many): search again once, as a person would.
        if (i === 12) await run(`document.querySelector('#search-input').dispatchEvent(new Event('input'))`);
      }
      return rows;
    };
    await run(`document.querySelector('#symbol-btn').click()`);
    await wait(300);
    check('search has no category selector', !(await run(`!!document.querySelector('#search-tabs')`)));
    const aapl = await search('AAPL');
    check('search puts the exact ticker first', aapl[0]?.t === 'AAPL' && aapl[0]?.src === 'Yahoo', JSON.stringify(aapl.slice(0, 3)));
    const btc = await search('BTC');
    const sources = new Set(btc.map((r) => r.src));
    check('one search covers stocks and crypto exchanges, each row labeled', btc.every((r) => r.src) && sources.has('Yahoo') && sources.has('Binance'), [...sources].join(', '));
    await run(`document.querySelector('#search-modal .close').click()`);

    // 11. News: ranked live headlines with tickers, news for the chart's symbol, economic calendar, earnings.
    await run(`document.querySelector('#nw-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.nw-row') && !!document.querySelector('.nw-table')`)) break; }
    const nw = await run(`({ rows: document.querySelectorAll('.nw-row').length, hot: document.querySelectorAll('.nw-row.hot').length,
      chips: document.querySelectorAll('.nw-list .nw-tk').length, days: document.querySelectorAll('.nw-cal .nw-day').length })`);
    check('news shows ranked headlines, the hottest flagged', nw.rows > 20 && nw.hot > 0 && nw.hot <= 10, JSON.stringify(nw));
    check('headlines are tagged with tickers', nw.chips > 5, `${nw.chips} chips`);
    check('the economic calendar is grouped by day', nw.days > 0, `${nw.days} days`);
    const tk = await run(`(() => { const b = [...document.querySelectorAll('.nw-list .nw-tk')].find((x) => x.dataset.full.startsWith('YAHOO:')); b.click(); return b.dataset.full; })()`);
    // The company's name joins the title once the live feed connects (a few seconds on a slow night).
    const named = JSON.stringify(`${tk.replace('YAHOO:', '')} `);
    for (let i = 0; i < 30; i++) { await wait(500); if (await run(`document.querySelector('.cell .lg-title').innerText.startsWith(${named})`)) break; }
    const tkChart = await run(`document.querySelector('.cell .lg-title').innerText`);
    check('clicking a ticker opens its chart', tkChart.startsWith(`${tk.replace('YAHOO:', '')} `), `${tk} -> ${tkChart.split('\n')[0]}`);
    await run(`document.querySelector('[data-view="symbol"]').click()`);
    for (let i = 0; i < 30; i++) { await wait(500); if (await run(`document.querySelectorAll('.nw-row').length > 0`)) break; }
    const symTab = await run(`document.querySelector('[data-view="symbol"]').textContent`);
    check('the symbol tab shows news about the active chart', symTab === tk.replace('YAHOO:', '') && (await run(`document.querySelectorAll('.nw-row').length`)) > 0, symTab);
    await run(`document.querySelector('[data-view="top"]').click(); document.querySelector('[data-cal="earnings"]').click()`);
    await wait(500);
    check('the earnings calendar lists companies', (await run(`document.querySelectorAll('.nw-er').length`)) > 0);
    // Other countries: every country's releases and earnings outside the US, picked in the calendar.
    await run(`document.querySelector('[data-cal="econ"]').click(); document.querySelector('.nw-pick').click()`);
    await wait(300);
    await run(`document.querySelector('[data-ccset="all"]').click()`);
    await wait(300);
    const cc = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('the economic calendar covers other countries', cc.length >= 5 && cc.includes('US') && cc.includes('UK'), cc.join(' '));
    await run(`document.querySelector('[data-cal="earnings"]').click(); const s = document.querySelector('select[data-f="minCap"]'); s.value = '1000000000'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
    await wait(300);
    const ecc = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('earnings include stock markets outside the US', ecc.some((c) => c !== 'US'), ecc.join(' '));
    await run(`document.querySelector('[data-ccset="us"]').click()`);
    await wait(300);
    const usOnly = await run(`[...new Set([...document.querySelectorAll('.nw-cal tbody .nw-cc')].map((x) => x.textContent))]`);
    check('"US only" narrows the calendar to the US', usOnly.length === 1 && usOnly[0] === 'US', usOnly.join(' '));
    await run(`document.querySelector('[data-ccset="major"]').click(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await wait(300);
    check('clicking outside closes the country list', !(await run(`!!document.querySelector('.nw-pop')`)));
    await run(`(() => { const s = document.querySelector('select[data-f="region"]'); s.value = 'gb'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.nw-feed .nw-row')`)) break; }
    const gb = await run(`({ rows: document.querySelectorAll('.nw-feed .nw-row').length, sources: [...new Set([...document.querySelectorAll('.nw-src')].map((x) => x.textContent))].slice(0, 6),
      local: [...document.querySelectorAll('.nw-list .nw-tk')].filter((b) => b.dataset.full.endsWith('.L')).length })`);
    check('news for another region shows its own outlets and companies', gb.rows > 10 && gb.local > 0 && !gb.sources.includes('Benzinga'), JSON.stringify(gb));
    await run(`(() => { const s = document.querySelector('select[data-f="region"]'); s.value = 'us'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await run(`document.querySelector('[data-cal="econ"]').click(); document.querySelector('#nw-close').click()`);

    // 12. Bar replay and paper trading (on a chart with plenty of history).
    await run(`window.__wickline.views()[0].setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 20; i++) { await wait(500); if (await run(`(() => { const v = window.__wickline.views()[0]; return v.state.symbol === 'BINANCE:BTCUSDT' && !!v.feed && v.bars.length > 100; })()`)) break; }
    const activeChart = `window.__wickline.views().find((x) => x.el.classList.contains('active')) || window.__wickline.views()[0]`;
    await run(`document.querySelector('#rp-btn').click()`);
    await wait(300);
    check('Replay asks where to start', await run(`!(${activeChart}).q('.rp-banner').hidden`));
    await run(`(${activeChart}).q('[data-rp="random"]').click()`);
    await wait(600);
    const rp = await run(`(() => { const v = ${activeChart}; return v.replay && { n: v.bars.length, all: v.replay.all.length, status: document.querySelector('#status-text').textContent, title: document.title }; })()`);
    check('a replay hides the candles after its start', !!rp && rp.n < rp.all && /^Replay/.test(rp.title), JSON.stringify(rp));
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))`);
    await wait(300);
    check('Shift+→ shows the next candle', (await run(`(${activeChart}).bars.length`)) === rp?.n + 1);
    await run(`document.querySelector('#tr-btn').click()`);
    await wait(400);
    const liveBefore = await run(`localStorage.getItem('wickline.paper')`);
    await run(`(${activeChart}).q('.qt [data-qt="buy"]').click()`);
    await wait(400);
    const practice = await run(`(() => { const v = ${activeChart}; return { pos: Object.keys(v.replayAccount?.positions || {}).length,
      badge: !!document.querySelector('#tr-account .tr-badge'), lines: v.paperLines.size }; })()`);
    check('buying in a replay opens a position in the practice account', practice.pos === 1 && practice.badge && practice.lines >= 1, JSON.stringify(practice));
    check('...and leaves the paper account alone', (await run(`localStorage.getItem('wickline.paper')`)) === liveBefore);
    await run(`(() => { const v = ${activeChart}; v.setReplaySpeed(10); v.playReplay(); })()`);
    await wait(1500);
    const played = await run(`(() => { const v = ${activeChart}; v.pauseReplay(); return v.bars.length; })()`);
    check('Play moves the replay forward', played > rp.n + 3, `${rp.n} -> ${played} candles`);
    await run(`(${activeChart}).q('.replay-bar [data-rp="exit"]').click()`);
    for (let i = 0; i < 20; i++) { await wait(500); if (await run(`!(${activeChart}).replay && !!(${activeChart}).feed`)) break; }
    const exited = await run(`({ replay: !!(${activeChart}).replay, toast: document.querySelector('#toast').innerText, title: document.title })`);
    check('Exit replay goes back to live data, with a summary', !exited.replay && /Replay finished/.test(exited.toast) && !/^Replay/.test(exited.title), JSON.stringify(exited));
    await run(`(${activeChart}).q('.qt [data-qt="buy"]').click()`);
    await wait(500);
    const paper = await run(`(() => { const a = JSON.parse(localStorage.getItem('wickline.paper') || '{}'); return { pos: Object.keys(a.positions || {}).length,
      lines: (${activeChart}).paperLines.size, row: !!document.querySelector('#tr-content [data-tr="close"]') }; })()`);
    check('a live paper trade opens a saved position with a line on the chart', paper.pos === 1 && paper.lines >= 1 && paper.row, JSON.stringify(paper));
    await run(`document.querySelector('#tr-content [data-tr="close"]').click()`);
    await wait(400);
    const closedTrades = await run(`JSON.parse(localStorage.getItem('wickline.paper')).trades.length`);
    check('closing it records the trade', closedTrades === 1, `${closedTrades} trades`);
    await run(`document.querySelector('#tr-close').click()`);
    // 13. Stock heatmap.
    await run(`document.querySelector('#hm-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`document.querySelectorAll('.hm-tile').length > 100`)) break; }
    const hm = await run(`({ tiles: document.querySelectorAll('.hm-tile').length, sectors: document.querySelectorAll('.hm-sector').length,
      colored: [...document.querySelectorAll('.hm-tile')].filter((t) => /rgb\\((?!46, 48, 56)/.test(t.style.background)).length })`);
    check('the heatmap shows the largest stocks by sector, coloured by their move', hm.tiles >= 400 && hm.sectors >= 5 && hm.colored > hm.tiles * 0.9, JSON.stringify(hm));
    await run(`document.querySelector('.hm-sector').click()`);
    await wait(300);
    const zoom = await run(`({ crumb: document.querySelector('.hm-crumb').innerText, tiles: document.querySelectorAll('.hm-tile').length })`);
    check('clicking a sector zooms in on it', /All sectors/.test(zoom.crumb) && zoom.tiles < hm.tiles, JSON.stringify(zoom));
    const hmSym = await run(`(() => { const t = document.querySelector('.hm-tile'); t.click(); return t.dataset.sym; })()`);
    // A cold daily history can take Yahoo several seconds; wait for the chart's title (up to 12 s).
    let hmChart = '';
    for (let i = 0; i < 40 && !hmChart.startsWith(`${hmSym} `); i++) {
      await wait(300);
      hmChart = await run(`document.querySelector('.cell.active .lg-title, .cell .lg-title').innerText`);
    }
    check('clicking a tile opens its chart', hmChart.startsWith(`${hmSym} `), `${hmSym} -> ${hmChart.split('\n')[0]}`);
    // ...other markets from the menu: crypto (without stablecoins) and stock markets outside the US.
    const hmMarket = async (id, min) => {
      await run(`(() => { const s = document.querySelector('#hm-tools [data-f="market"]'); s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      for (let i = 0; i < 80; i++) { await wait(500); if (await run(`document.querySelectorAll('.hm-tile').length >= ${min} || !!document.querySelector('#hm-body [data-hm-retry]')`)) break; }
      return run(`({ tiles: document.querySelectorAll('.hm-tile').length, groups: document.querySelectorAll('.hm-sector').length,
        colored: [...document.querySelectorAll('.hm-tile')].filter((t) => /rgb\\((?!46, 48, 56)/.test(t.style.background)).length,
        syms: [...document.querySelectorAll('.hm-tile')].map((t) => t.dataset.sym),
        legend: document.querySelector('.hm-updated')?.innerText || '',
        off: [...document.querySelectorAll('#hm-tools [data-hm-period]:disabled')].map((b) => b.textContent),
        error: document.querySelector('#hm-body .st-empty')?.innerText.replace(/\\s+/g, ' ').slice(0, 160) || null })`);
    };
    const short = (m) => JSON.stringify({ ...m, syms: m.syms.slice(0, 10) });
    const cr = await hmMarket('crypto', 50);
    const PEGGED = ['USDT', 'USDC', 'DAI', 'USDE', 'USDS', 'FDUSD', 'PYUSD', 'TUSD', 'USD1', 'RLUSD', 'WBTC', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'XAUT', 'PAXG'];
    check('Crypto: the top coins, coloured by their move, without stablecoins or wrapped copies',
      cr.colored >= 50 && cr.syms.includes('BTC') && !cr.syms.some((s) => PEGGED.includes(s) || /USD/.test(s)), short(cr));
    const coinFull = await run(`(() => { const t = document.querySelector('.hm-tile[data-sym="BTC"]') || document.querySelector('.hm-tile[data-full]'); t.click(); return t.dataset.full; })()`);
    let coinChart = '';
    for (let i = 0; i < 20; i++) {
      await wait(500);
      coinChart = await run(`(() => { const v = ${activeChart}; return v.state.symbol + ' | ' + v.el.querySelector('.lg-title').innerText.split('\\n')[0]; })()`);
      if (coinChart.startsWith(`${coinFull} | ${coinFull.split(':')[1]}`)) break;
    }
    check('...clicking a coin opens its chart (Binance pair, else Yahoo)', /^(BINANCE|YAHOO):/.test(coinFull) && coinChart.startsWith(`${coinFull} | ${coinFull.split(':')[1]}`), `${coinFull} -> ${coinChart}`);
    for (const [id, cur] of [['GB', 'GBP'], ['JP', 'JPY'], ['DE', 'EUR']]) {
      const m = await hmMarket(id, 50);
      check(`${id} stocks: tiles by sector, coloured, sized in ${cur}`, m.tiles >= 50 && m.groups >= 5 && m.colored > m.tiles * 0.8 && m.legend.includes(cur), short(m));
    }
    await hmMarket('us', 100);
    await run(`document.querySelector('#hm-close').click()`);

    // 13b. Options: a US ETF's chain from Yahoo (expiries, rows around the price, stats), a contract
    // opens its own chart, Bitcoin's chain from Deribit, and a friendly message for forex.
    await run(`(${activeChart}).setSymbol('YAHOO:SPY')`);
    for (let i = 0; i < 30; i++) { await wait(500); if (await run(`(() => { const v = ${activeChart}; return v.state.symbol === 'YAHOO:SPY' && v.bars.length > 10; })()`)) break; }
    await run(`document.querySelector('#op-btn').click()`);
    for (let i = 0; i < 60; i++) { await wait(500); if (await run(`!!document.querySelector('.op-table tbody tr[data-i]') || !!document.querySelector('#op-body [data-op-retry], .op-none')`)) break; }
    const opInfo = () => run(`(() => { const c = document.querySelector('.op-chain'), s = c?.querySelector('.op-spot'), btn = document.querySelector('#op-tools .op-exp-btn');
      return { symbol: document.querySelector('#op-symbol').textContent, src: document.querySelector('#op-src').innerText.trim(),
        expiries: Number(document.querySelector('#op-tools .op-count')?.textContent.match(/\\d+/)?.[0] || 0), expiry: btn?.dataset.exp ?? null, rows: document.querySelectorAll('.op-table tbody tr[data-i]').length,
        atmVisible: !!s && s.offsetTop >= c.scrollTop && s.offsetTop <= c.scrollTop + c.clientHeight,
        kpis: [...document.querySelectorAll('.op-kpis .st-kpi')].map((k) => [k.querySelector('span').textContent, k.querySelector('b').textContent]),
        chart: !!document.querySelector('.op-oi canvas'), unusual: document.querySelectorAll('.op-ua-row').length + document.querySelectorAll('.op-ua-list .op-note').length,
        error: document.querySelector('#op-body .st-empty')?.innerText.replace(/\\s+/g, ' ').slice(0, 160) || null }; })()`);
    const spy = await opInfo();
    const kpi = (info, label) => (info.kpis.find(([l]) => l === label) || [])[1] || '';
    const shortOp = (o) => JSON.stringify({ ...o, kpis: o.kpis.map(([l, v]) => `${l}: ${v}`).join(', ') }).slice(0, 400);
    check('Options: SPY\'s chain from Yahoo, many expiries, centred on the price', spy.symbol === 'SPY' && spy.expiries >= 5 && spy.rows >= 20 && spy.atmVisible
      && spy.src === 'Delayed ~15 min · Yahoo', shortOp(spy));
    check('...with the price, ATM IV and expected move filled in', /^[\d,.]+$/.test(spy.kpis[0]?.[1] || '') && /^\d+(\.\d)?%$/.test(kpi(spy, 'ATM IV'))
      && /^±[\d,.]+$/.test(kpi(spy, 'Expected move')) && /^±[\d,.]+$/.test(kpi(spy, '1σ move')) && spy.chart && spy.unusual > 0, shortOp(spy));
    const firstExpiry = spy.expiry;
    await run(`document.querySelector('#op-tools .op-exp-btn').click()`);
    await wait(300);
    const opMenu = await run(`(() => { const m = document.querySelector('.op-exp-menu'); return { open: !m.hidden, rows: m.querySelectorAll('.op-exp-row').length, monthly: m.querySelectorAll('.op-exp-row.op-monthly').length, months: m.querySelectorAll('.menu-title').length, on: m.querySelectorAll('.op-exp-row.on').length }; })()`);
    const wantExpiry = await run(`(() => { const c = document.querySelectorAll('.op-exp-menu .op-exp-row')[3]; c.click(); return c.dataset.exp; })()`);
    const expiryKpi = kpi(spy, 'Expiry');
    for (let i = 0; i < 30; i++) { await wait(500); const o = await opInfo(); if (o.expiry === wantExpiry && kpi(o, 'Expiry') !== expiryKpi && o.rows >= 20) break; }
    const spy2 = await opInfo();
    check('...the expiry menu lists every expiry by month, marks monthlies and the picked one', opMenu.open && opMenu.rows === spy.expiries && opMenu.monthly >= 1 && opMenu.months >= 2 && opMenu.on === 1, JSON.stringify(opMenu));
    check('...and closes once one is picked', await run(`document.querySelector('.op-exp-menu').hidden`));
    check('...another expiry loads its own chain', spy2.expiry !== firstExpiry && kpi(spy2, 'Expiry') !== expiryKpi && spy2.rows >= 20 && spy2.atmVisible, shortOp(spy2));
    const contract = await run(`(() => { const td = document.querySelector('.op-spot').nextElementSibling.querySelector('td[data-side="c"]');
      const k = td.closest('tr').querySelector('.op-k').textContent; setTimeout(() => td.click(), 0); return k; })()`);
    let opChart = null;
    for (let i = 0; i < 40; i++) {
      await wait(500);
      opChart = await run(`(() => { const v = ${activeChart}, err = v.el.querySelector('.overlay.error');
        return { symbol: v.state.symbol, bars: v.bars.length, legend: v.el.querySelector('.lg-ohlc')?.innerText.replace(/\\s+/g, ' ').trim(),
          error: err.hidden ? null : err.innerText.replace(/\\s+/g, ' ').slice(0, 120), panel: document.querySelector('#op-symbol').textContent }; })()`);
      if (opChart.error || (opChart.bars > 0 && /\\d/.test(opChart.legend || ''))) break;
    }
    check('...clicking a contract opens its chart, and the panel stays on SPY', /^YAHOO:SPY\d{6}C\d{8}$/.test(opChart.symbol) && opChart.bars > 0 && !opChart.error
      && /^O\S+ H\S+ L\S+ C\S+/.test(opChart.legend || '') && opChart.panel === 'SPY', `strike ${contract}: ${JSON.stringify(opChart)}`);
    await run(`(${activeChart}).setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 40; i++) { await wait(500); if (await run(`document.querySelector('#op-symbol').textContent === 'BTC' && (!!document.querySelector('.op-table tbody tr[data-i]') || !!document.querySelector('#op-body [data-op-retry]'))`)) break; }
    const btcOp = await opInfo();
    check('Options follow the chart: Bitcoin\'s chain from Deribit, in real time', btcOp.symbol === 'BTC' && btcOp.src === 'Real time · Deribit' && btcOp.expiries >= 3
      && btcOp.rows >= 10 && btcOp.atmVisible && /^\d+(\.\d)?%$/.test(kpi(btcOp, 'ATM IV')) && /^[\d,]+$/.test(kpi(btcOp, 'Max pain')), shortOp(btcOp));
    await run(`(${activeChart}).setSymbol('YAHOO:EURUSD=X')`);
    for (let i = 0; i < 30; i++) { await wait(500); if (await run(`!!document.querySelector('.op-none')`)) break; }
    const fxOp = await run(`document.querySelector('#op-body').innerText.replace(/\\s+/g, ' ').trim()`);
    check('...and a forex pair says it has no options', /^No options for EURUSD=X/.test(fxOp), fxOp.slice(0, 120));
    await run(`document.querySelector('#op-close').click()`);
    await run(`(${activeChart}).setSymbol('BINANCE:BTCUSDT')`);
    for (let i = 0; i < 20; i++) { await wait(500); if (await run(`(() => { const v = ${activeChart}; return v.state.symbol === 'BINANCE:BTCUSDT' && v.bars.length > 100; })()`)) break; }

    // 14. Community scripts: the library lists published scripts, one click adds one to the chart,
    // Publish opens GitHub's form with the script filled in, and scripts can't reach the network.
    await run(`document.querySelector('#ind-btn').click()`);
    await wait(300);
    await run(`document.querySelector('[data-cat="Community"]').click()`);
    for (let i = 0; i < 30; i++) { await wait(300); if (await run(`document.querySelectorAll('.cm-item').length > 0`)) break; }
    const cm = await run(`({ items: document.querySelectorAll('.cm-item').length, strategies: document.querySelectorAll('.cm-kind.strategy').length })`);
    check('the Community tab lists published scripts', cm.items >= 10 && cm.strategies >= 5, JSON.stringify(cm));
    await run(`document.querySelector('[data-comm="wickline-supertrend-adx"]').click()`);
    let added = null;
    for (let i = 0; i < 30 && !added?.plots; i++) {
      await wait(400);
      added = await run(`(() => { for (const v of window.__wickline.views()) for (const e of v.live.values())
        if (e.def?.name === 'Supertrend + ADX') return { error: e.error || null, plots: e.out ? Object.keys(e.out).length : 0, strategy: !!e.report };
        return null; })()`);
    }
    check('one click adds a community strategy to the chart, and it runs', added && !added.error && added.plots > 0 && added.strategy, JSON.stringify(added));
    check('...as a copy in My scripts', await run(`JSON.parse(localStorage.getItem('wickline.scripts') || '[]').some((s) => s.community?.id === 'wickline-supertrend-adx')`));
    const testerList = await run(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
      const wasHidden = document.querySelector('#tester').hidden;
      if (wasHidden) document.querySelector('#st-btn').click();
      await w(300);
      const opts = [...document.querySelectorAll('#st-select option')].map((o) => o.textContent);
      const summary = !!document.querySelector('#st-content .st-empty') ? 'empty' : 'results';
      if (wasHidden) document.querySelector('#st-close').click();
      return { opts, summary }; })()`);
    check('...and the Strategy tester lists it with results', testerList.opts.includes('Supertrend + ADX') && testerList.summary === 'results', JSON.stringify(testerList));
    const pub = await run(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms));
      let opened = null; const orig = window.open; window.open = (u) => { opened = u; return null; };
      document.querySelector('#ed-btn').click(); await w(300);
      document.querySelector('#ed-publish').click(); await w(1500);
      const shown = !document.querySelector('#publish-modal').hidden;
      document.querySelector('#pub-desc').value = 'A script published by the end-to-end test.';
      document.querySelector('#pub-license').checked = true;
      document.querySelector('#publish-form').requestSubmit(); await w(300);
      window.open = orig; document.querySelector('#ed-close').click();
      const u = opened && new URL(opened);
      return { shown, host: u?.host, template: u?.searchParams.get('template'), hasCode: /(indicator|strategy)\\(/.test(u?.searchParams.get('code') || '') }; })()`);
    check('Publish opens GitHub\'s form with the script filled in', pub.shown && pub.host === 'github.com' && pub.template === 'publish-script.yml' && pub.hasCode, JSON.stringify(pub));
    const net = await run(`(async () => { const { engine } = await import('/js/scripts.js');
      const res = await engine().run("indicator('Net'); const g = (() => {}).constructor('return this')(); log([typeof g.fetch, typeof g.XMLHttpRequest, typeof g.WebSocket, typeof g.indexedDB, typeof g.importScripts].join(' ')); plot(close);",
        window.__wickline.views()[0].bars);
      return res.logs[0]; })()`);
    check('scripts have no way to reach the network or the app\'s storage', net === 'undefined undefined undefined undefined undefined', net);

    check('the header fits without scrolling', await run(`(() => { const t = document.querySelector('.topbar'); return t.scrollWidth <= t.clientWidth; })()`));
    // ...at any width from small laptops up (labels hide a group at a time).
    const headerFits = () => run(`(async () => { const t = document.querySelector('.topbar'); const bad = [];
      for (const w of [1280, 1366, 1500, 1600, 1720, 1800, 1950, 2400]) {
        t.style.width = w + 'px';
        // A hidden test window delivers resize callbacks late, so give it up to 2 seconds.
        let fit = false;
        for (let k = 0; k < 20 && !fit; k++) { await new Promise((r) => setTimeout(r, 100)); fit = t.scrollWidth <= t.clientWidth; }
        if (!fit) bad.push(w);
      }
      t.style.width = ''; return bad; })()`);
    const fits = await headerFits();
    check('...at every width from 1280 to 2400 px', fits.length === 0, fits.join(', '));
    // Narrower (vertical monitors, half-screen windows, phones): what doesn't fit moves into the "⋯" menu.
    const narrow = await run(`(async () => { const t = document.querySelector('.topbar'); const more = document.querySelector('#more-btn'); const bad = [];
      for (const w of [1080, 900, 700, 540, 360]) {
        t.style.width = w + 'px';
        let fit = false;
        for (let k = 0; k < 20 && !fit; k++) { await new Promise((r) => setTimeout(r, 100)); fit = t.scrollWidth <= t.clientWidth; }
        const moved = [...t.querySelectorAll('.tb-btn.ovf')].map((b) => b.id);
        let listed = [];
        if (!more.hidden) { more.click(); listed = [...document.querySelectorAll('#more-menu [data-for]')].map((i) => i.dataset.for); more.click(); }
        if (!fit || !moved.length || listed.join() !== moved.join()) bad.push(w + ' px: ' + moved.length + ' moved, ' + listed.length + ' listed');
      }
      // A menu item does what its button does: Layout opens the layout picker under the "⋯".
      more.click(); document.querySelector('#more-menu [data-for="layout-btn"]').click();
      const lm = document.querySelector('#layout-menu'); const picker = !lm.hidden && document.querySelector('#more-menu').hidden;
      lm.hidden = true; t.style.width = ''; return { bad, picker }; })()`);
    check('...and narrower, with the rest in the "⋯" menu', narrow.bad.length === 0, narrow.bad.join(', '));
    check('...whose items work like the buttons', narrow.picker);

    // 9. Network proxy (Data sources): the window's exchange connections and the built-in server's
    // Yahoo requests and stream all go through a local test proxy; the app's own server doesn't.
    const httpProxy = await startHttpProxy();
    const socksProxy = await startSocks5Proxy();
    await open('YAHOO:AAPL', '1D');
    await run(`document.querySelector('#settings-btn').click()`);
    await wait(800);
    const pv = await run(`({ shown: !document.querySelector('#set-proxy').hidden, mode: document.querySelector('#set-proxy-mode').value,
      server: !document.querySelector('#set-proxy-row').hidden })`);
    check('Data sources has the network proxy, on "system" at first', pv.shown && pv.mode === 'system' && !pv.server, JSON.stringify(pv));
    await run(`(() => { const m = document.querySelector('#set-proxy-mode'); m.value = 'manual'; m.dispatchEvent(new Event('change'));
      document.querySelector('#set-proxy-server').value = '127.0.0.1'; document.querySelector('#settings-form').requestSubmit(); })()`);
    await wait(800);
    const refused = await run(`({ open: !document.querySelector('#settings-modal').hidden, row: !document.querySelector('#set-proxy-row').hidden,
      msg: document.querySelector('#set-status').textContent })`);
    check('...refuses a proxy without a port, saying why', refused.open && refused.row && /port/.test(refused.msg), refused.msg);
    // Saving reloads the page: wait for that before going on (navigating meanwhile would race it).
    const savedReload = new Promise((r) => win.webContents.once('did-finish-load', r));
    await run(`document.querySelector('#set-proxy-server').value = '127.0.0.1:${httpProxy.port}'; document.querySelector('#settings-form').requestSubmit()`);
    await Promise.race([savedReload, wait(20000)]);
    // Symbols not opened before, so nothing comes from a cache.
    const through = async (proxy, label, symbols) => {
      const before = proxy.seen.length;
      const charts = [];
      for (const [sym, tf] of symbols) {
        const r = await open(sym, tf);
        charts.push(r.error ? `${sym}: ${r.error}` : null);
        await wait(2500); // let the live streams connect
      }
      const seen = [...new Set(proxy.seen.slice(before))];
      const has = (re) => seen.some((h) => re.test(h));
      check(`charts load through ${label}`, charts.every((c) => !c), charts.filter(Boolean).join(' | '));
      check(`...the server's Yahoo requests and stream use it`, has(/^query[12]\.finance\.yahoo\.com:443$/) && has(/^streamer\.finance\.yahoo\.com:443$/), seen.join(' '));
      check(`...and so do the window's exchange requests and streams`, has(/^(data-api\.binance\.vision|api\.binance\.com):443$/)
        && has(/^(data-stream\.binance\.vision:443|stream\.binance\.com:9443)$/) && has(/^api\.exchange\.coinbase\.com:443$/)
        && has(/^ws-feed\.exchange\.coinbase\.com:443$/), seen.join(' '));
      check("...but not the app's own server", !seen.some((h) => h.startsWith('127.0.0.1') || h.startsWith('localhost')), seen.join(' '));
    };
    await through(httpProxy, 'an HTTP proxy', [['YAHOO:MSFT', '1D'], ['BINANCE:ETHUSDT', '1m'], ['COINBASE:ETH-USD', '1h']]);
    const now = await run(`window.wicklineDesktop.getProxy()`);
    check('...and the dialog says which proxy is in use', now.mode === 'manual' && now.active === httpProxy.url, JSON.stringify(now));
    const socksSet = await run(`window.wicklineDesktop.setProxy({ mode: 'manual', server: '${socksProxy.url}' })`);
    check('switching to SOCKS5 takes effect without a restart', socksSet.ok && socksSet.active === socksProxy.url, JSON.stringify(socksSet));
    await through(socksProxy, 'a SOCKS5 proxy', [['YAHOO:AMZN', '1D'], ['BINANCE:SOLUSDT', '1m'], ['COINBASE:SOL-USD', '1h']]);
    const off = await run(`window.wicklineDesktop.setProxy({ mode: 'off', server: '' })`);
    const seenBefore = httpProxy.seen.length + socksProxy.seen.length;
    const direct = await open('BINANCE:BTCUSDT', '1h');
    await wait(1500);
    check('turning the proxy off connects directly again', off.ok && off.active === 'direct' && !direct.error
      && httpProxy.seen.length + socksProxy.seen.length === seenBefore, direct.error || JSON.stringify(off));
    await run(`window.wicklineDesktop.setProxy({ mode: 'system', server: '' })`);
    await httpProxy.close();
    await socksProxy.close();

    // 10. UI language (Data sources → Language): every other language, then back to the system's (English here).
    const pickLang = async (id) => {
      await open('YAHOO:AAPL', '1D');
      await run(`document.querySelector('#settings-btn').click()`);
      await wait(500);
      const reloaded = new Promise((r) => win.webContents.once('did-finish-load', r));
      await run(`(() => { const s = document.querySelector('#set-lang'); s.value = '${id}'; document.querySelector('#settings-form').requestSubmit(); })()`);
      await Promise.race([reloaded, wait(20000)]);
      for (let i = 0; i < 40; i++) { await wait(500); if (await run(`/\\d/.test(document.querySelector('.cell .lg-ohlc')?.innerText || '')`)) break; }
      return run(`({ lang: document.documentElement.lang, ind: document.querySelector('#ind-btn span').textContent,
        options: [...document.querySelectorAll('#set-lang option')].map((o) => o.value).join(),
        status: document.querySelector('#status-text').textContent, legend: document.querySelector('.cell .lg-ohlc')?.innerText.replace(/\\s+/g, ' ').trim() || '' })`);
    };
    // Prices in the legend use the language's decimal mark: AAPL's "O348,03 H…" in Spanish, Portuguese, Italian, German and French.
    const decimals = (id, legend) => (['es', 'pt-BR', 'it', 'de', 'fr'].includes(id) ? /^O[\d.]*\d,\d\d /.test(legend) : /^O[\d,]*\d\.\d\d /.test(legend));
    const langIds = LANGUAGES.map((x) => x.id);
    for (const id of langIds.filter((x) => x !== 'en')) {
      const word = (await import(`../public/js/lang/${id}.js`)).default['app.hdr.ind'];
      const l = await pickLang(id);
      check(`the UI switches to ${id}`, l.lang === id && l.ind === word && decimals(id, l.legend) && l.options === ['', ...langIds].join(), JSON.stringify(l));
      const langFits = await headerFits();
      check(`...and its header fits at every width from 1280 to 2400 px`, langFits.length === 0, langFits.join(', '));
    }
    const back = await pickLang('');
    check('...and back to the system language (English)', back.lang === 'en' && back.ind === 'Indicators' && decimals('en', back.legend), JSON.stringify(back));

    check('no errors in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('test run', false, e.stack);
  }

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  server.close();
  app.exit(failed ? 1 : 0);
});
