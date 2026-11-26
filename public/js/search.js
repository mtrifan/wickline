import { searchCrypto, searchYahoo, warmSymbolLists, parseSymbol } from './datafeed.js';
import { isServerMode } from './env.js';
import { $, esc } from './util.js';
import { t, lang } from './i18n.js';

const p = (full, ticker, name, exchange, type, category) => ({ full, ticker, name, exchange, type, category });
const POPULAR = [
  p('BINANCE:BTCUSDT', 'BTCUSDT', 'BTC / USDT', 'Binance', 'Crypto', 'crypto'),
  p('BINANCE:ETHUSDT', 'ETHUSDT', 'ETH / USDT', 'Binance', 'Crypto', 'crypto'),
  p('BINANCEF:BTCUSDT', 'BTCUSDT.P', t('feed.perpName', { base: 'BTC', quote: 'USDT' }), 'Binance Futures', 'Crypto perpetual', 'crypto'),
  p('COINBASE:BTC-USD', 'BTC-USD', 'BTC / USD', 'Coinbase', 'Crypto', 'crypto'),
  p('YAHOO:AAPL', 'AAPL', 'Apple Inc.', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:NVDA', 'NVDA', 'NVIDIA Corporation', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:TSLA', 'TSLA', 'Tesla, Inc.', 'NASDAQ', 'Stock', 'stocks'),
  p('YAHOO:SPY', 'SPY', 'SPDR S&P 500 ETF', 'NYSE Arca', 'ETF', 'funds'),
  p('YAHOO:QQQ', 'QQQ', 'Invesco QQQ (Nasdaq 100)', 'NASDAQ', 'ETF', 'funds'),
  p('YAHOO:^GSPC', '^GSPC', 'S&P 500', 'Index', 'Index', 'indices'),
  p('YAHOO:^IXIC', '^IXIC', 'NASDAQ Composite', 'Index', 'Index', 'indices'),
  p('YAHOO:^GDAXI', '^GDAXI', 'DAX', 'Index', 'Index', 'indices'),
  p('YAHOO:EURUSD=X', 'EURUSD=X', 'EUR / USD', 'Forex', 'Currency', 'forex'),
  p('YAHOO:USDJPY=X', 'USDJPY=X', 'USD / JPY', 'Forex', 'Currency', 'forex'),
  p('YAHOO:GC=F', 'GC=F', 'Gold Futures', 'COMEX', 'Futures', 'futures'),
  p('YAHOO:CL=F', 'CL=F', 'Crude Oil Futures', 'NYMEX', 'Futures', 'futures'),
  p('YAHOO:ES=F', 'ES=F', 'S&P 500 E-mini Futures', 'CME', 'Futures', 'futures'),
];

const TITLES = {
  open: t('search.title.open'), add: t('search.title.add'), compare: t('search.title.compare'), alert: t('search.title.alert'),
};

// Instrument types (and the words Index / Forex / Crypto in the exchange column) in the UI language.
// Display only: rows keep the English type, and English shows it as the source gives it.
const TYPE_KEYS = {
  stock: 'stock', equity: 'stock', 'common stock': 'stock', index: 'index', currency: 'currency',
  'physical currency': 'currency', forex: 'forex', futures: 'futures', future: 'futures', crypto: 'crypto',
  cryptocurrency: 'crypto', 'digital currency': 'crypto', 'crypto perpetual': 'cryptoPerp', fund: 'fund',
  'mutual fund': 'mutualFund', mutualfund: 'mutualFund', 'depositary receipt': 'depositary',
  'preferred stock': 'preferred', bond: 'bond', warrant: 'warrant',
};
function typeLabel(word) {
  const key = lang !== 'en' && TYPE_KEYS[String(word || '').toLowerCase()];
  return key ? t(`search.type.${key}`) : word;
}

/** Where a result's data comes from, shown as a badge on its row. */
function sourceOf(r) {
  const src = parseSymbol(r.full).source;
  if (src === 'BINANCE') return { key: 'binance', label: 'Binance' };
  if (src === 'BINANCEF') return { key: 'binance', label: 'Binance Futures' };
  if (src === 'COINBASE') return { key: 'coinbase', label: 'Coinbase' };
  if (src === 'BYBIT' || src === 'BYBITF') return { key: 'bybit', label: src === 'BYBIT' ? 'Bybit' : 'Bybit Futures' };
  if (src === 'OKX' || src === 'OKXF') return { key: 'okx', label: src === 'OKX' ? 'OKX' : 'OKX Futures' };
  return isServerMode() ? { key: 'yahoo', label: 'Yahoo' } : { key: 'twelvedata', label: 'Twelve Data' };
}

// Short names traders know, for the long ones Yahoo returns.
const EXCHANGE_SHORT = {
  'Chicago Mercantile Exchange': 'CME', 'Chicago Board of Trade': 'CBOT', 'New York Commodity Exchange': 'COMEX',
  'New York Mercantile Exchange': 'NYMEX', 'BATS Trading': 'Cboe BZX', 'Zurich Stock Exchange': 'SIX',
  'Chicago Board Options Exchange': 'Cboe', 'Nasdaq GIDS': 'Nasdaq', 'NYSEArca': 'NYSE Arca', CCC: 'Crypto', CCY: 'Forex',
};
const shortExchange = (e) => EXCHANGE_SHORT[e] || e;

const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** How well a result matches the query (higher first). */
function score(r, Q, lower) {
  const t = norm(String(r.ticker).replace(/\.P$/, '')); // BTCUSDT.P (perpetual) -> BTCUSDT
  const base = r.category === 'crypto' ? norm(String(r.name).split('/')[0]) : '';
  const name = String(r.name || '').toLowerCase();
  if (t === Q) return 100;
  if (base && base === Q) return 92;
  // The query plus an exchange or type suffix: SAP.DE, BTC-USD, GC=F.
  const root = norm(String(r.ticker).split(/[.=^-]/).filter(Boolean)[0]);
  if (r.category !== 'crypto' && root === Q) return 90;
  if (t.startsWith(Q)) return 75;
  if (name.startsWith(lower)) return 60;
  if (base && base.startsWith(Q)) return 55;
  if (name.includes(lower)) return 40;
  return 20;
}

/** One list from every source, best matches first; ties keep each source's own order. */
function mergeResults(lists, q) {
  const Q = norm(q), lower = q.toLowerCase();
  const all = lists.flatMap((list) => list.map((r, i) => ({ r, i, s: score(r, Q, lower) })));
  // Ties keep each source's own order, except prefix matches, where the shorter ticker wins.
  all.sort((a, b) => b.s - a.s || (a.s === 75 ? a.r.ticker.length - b.r.ticker.length : 0) || a.i - b.i);
  const seen = new Set();
  return all.map((x) => x.r).filter((r) => !seen.has(r.full) && seen.add(r.full)).slice(0, 60);
}

export class SymbolSearch {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.el = $('#search-modal');
    this.input = $('#search-input');
    this.list = $('#search-results');
    this.mode = 'open';
    this.crypto = [];
    this.yahoo = [];
    this.rows = [];
    this.active = 0;
    this.seq = 0;
    this.yahooTimer = null;

    this.input.addEventListener('input', () => this.query());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('mousedown', (e) => { if (e.target === this.el) this.close(); });
    this.el.querySelector('.close').addEventListener('click', () => this.close());
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (row) this.pick(Number(row.dataset.i));
    });
  }

  get isOpen() { return !this.el.hidden; }

  open(mode = 'open', text = '') {
    this.mode = mode;
    this.el.hidden = false;
    this.el.querySelector('.search-title').textContent = TITLES[mode] || TITLES.open;
    this.input.value = text;
    this.input.focus();
    this.query();
    warmSymbolLists();
  }

  query() {
    const q = this.input.value.trim();
    const seq = ++this.seq;
    clearTimeout(this.yahooTimer);
    // Drop results for the previous text right away, so Enter never picks a stale row.
    this.crypto = [];
    this.yahoo = [];
    this.render(q);
    if (!q) return;
    searchCrypto(q)
      .then((rows) => { if (seq === this.seq) { this.crypto = rows; this.render(q); } })
      .catch(() => { if (seq === this.seq) { this.crypto = []; this.render(q); } });
    this.yahooTimer = setTimeout(() => {
      searchYahoo(q)
        .then((rows) => { if (seq === this.seq) { this.yahoo = rows; this.render(q); } })
        .catch(() => { if (seq === this.seq) { this.yahoo = []; this.render(q); } });
    }, 220);
  }

  render(q) {
    const rows = q ? mergeResults([this.yahoo, this.crypto], q) : POPULAR;
    this.rows = rows;
    let html = q ? '' : `<div class="sr-section">${t('search.popular')}</div>`;
    rows.forEach((r, i) => {
      const src = sourceOf(r);
      // Crypto rows: the exchange is the source. Others: the exchange, then where the data comes from.
      const exch = ['binance', 'coinbase', 'bybit', 'okx'].includes(src.key) ? '' : shortExchange(r.exchange);
      html += `<div class="sr-row" data-i="${i}">
          <span class="sr-ticker">${esc(r.ticker)}</span>
          <span class="sr-name">${esc(r.name)}</span>
          <span class="sr-type">${esc(typeLabel(r.type))}</span>
          <span class="sr-src">${exch ? `<span class="sr-exch">${esc(typeLabel(exch))}</span>` : ''}<span class="sr-badge" data-src="${src.key}" title="${esc(t('search.dataFrom', { source: src.label }))}">${esc(src.label)}</span></span>
        </div>`;
    });
    if (!rows.length) html = `<div class="sr-empty">${q ? t('search.searching') : t('search.typeToSearch')}</div>`;
    this.list.innerHTML = html;
    this.active = 0;
    this.highlight();
    // Enter was pressed before results arrived: take the best match now.
    if (this.pendingEnter && this.rows.length) { this.pendingEnter = false; this.pick(0); }
  }

  highlight() {
    this.list.querySelectorAll('.sr-row').forEach((el) => {
      const on = Number(el.dataset.i) === this.active;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }

  onKey(e) {
    if (e.key === 'ArrowDown') { this.active = Math.min(this.active + 1, this.rows.length - 1); this.highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.active = Math.max(this.active - 1, 0); this.highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      if (this.rows.length) this.pick(this.active);
      else if (this.input.value.trim()) {
        // Results may still be loading: wait briefly for them, then fall back to the raw text.
        this.pendingEnter = true;
        const text = this.input.value.trim();
        setTimeout(() => { if (this.pendingEnter && this.isOpen) { this.pendingEnter = false; this.pickRaw(text); } }, 2500);
      }
    } else if (e.key === 'Escape') { this.close(); e.stopPropagation(); }
  }

  pick(i) {
    const r = this.rows[i];
    if (!r) return;
    this.close();
    this.onSelect(r.full, this.mode);
  }

  pickRaw(text) {
    this.close();
    const t = text.toUpperCase().replace(/\s+/g, '');
    const looksCrypto = /^[A-Z0-9]{2,12}(USDT|USDC|FDUSD|BTC|ETH|BNB)$/.test(t);
    const full = t.includes(':') ? t : looksCrypto ? `BINANCE:${t}` : `YAHOO:${t}`;
    this.onSelect(full, this.mode);
  }

  close() {
    this.el.hidden = true;
    this.pendingEnter = false;
    clearTimeout(this.yahooTimer);
  }
}
