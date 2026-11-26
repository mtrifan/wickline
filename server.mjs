// OPTIONAL Wickline server. The app in public/ is a static site that runs anywhere without it.
// Running this adds keyless stock data: it relays Yahoo Finance (which blocks direct browser
// requests from other sites), the live Yahoo price stream, Yahoo screeners and live Nasdaq lists.
// The app detects it automatically (GET /api/health).
// Needs Node.js 22+ (built-in fetch and WebSocket) and nothing else, unless it goes through a proxy:
// set WICKLINE_PROXY (or HTTPS_PROXY / ALL_PROXY), which uses the undici package (npm install).

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { fetchUsList } from './lib/market-lists.mjs';
import { cleanSpikes, fixFxDailyCloses, isStaleHistory, spliceFreshTail } from './lib/clean-bars.mjs';
import { technicals, buildRow, insights } from './lib/screener.mjs';
import { parseFeed, buildNameIndex, buildStories, rankStories, CRYPTO } from './lib/news.mjs';
import { parseFomc, shapeEcon, shapeEarnings } from './lib/calendar.mjs';
import { MARKETS, MARKET_ORDER, FX_FALLBACK, usCountries, quoteCapUsd, shapeIntlEarnings, shapeListings, mergeMarkets } from './lib/markets.mjs';
import { HEATMAP_MARKETS, heatmapMarket, marketStocks } from './lib/heatmap-markets.mjs';
import { optionsQuery, optionsBody } from './lib/options.mjs';
import { communityFile, isCommunityPath } from './lib/community.mjs';
import { envProxy, onServerProxyChange, setServerProxy } from './lib/proxy.mjs';
import { parseTf, yahooPlan, aggregateSessions, sessionStart } from './public/js/timeframes.js';

// The app's version (package.json), reported by /api/health for the desktop app's update notice.
const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; } catch { return null; } })();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const SCRIPT_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'";

// ---------------------------------------------------------------------------
// Yahoo Finance relay
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const cache = new Map();

async function yahooGet(pathAndQuery, ttlMs) {
  const hit = cache.get(pathAndQuery);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;

  let lastErr = new Error('Yahoo request failed');
  for (const host of YAHOO_HOSTS) {
    try {
      const r = await fetch(`https://${host}${pathAndQuery}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data) {
        const msg = data?.chart?.error?.description || data?.finance?.error?.description;
        lastErr = new Error(msg || `Yahoo HTTP ${r.status}`);
        lastErr.status = r.status === 404 ? 404 : 502;
        if (r.status === 404) break;
        continue;
      }
      if (cache.size > 400) cache.clear();
      cache.set(pathAndQuery, { t: Date.now(), data });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  // Yahoo rate-limits bursts; serve the last good copy rather than failing.
  if (hit && lastErr.status !== 404) return hit.data;
  throw lastErr;
}

// Timeframe → Yahoo request settings: yahooPlan() in public/js/timeframes.js. Any timeframe works:
// Yahoo's own interval when it has one, else bars grouped by session from a smaller one (2h from
// 60m, 45m from 15m). `spacing` is the base bar length, used to merge Yahoo's irregular "live" points.
const DAY = 86400;

/**
 * Session opens from a chart answer's meta, in chart time (exchange time at today's offset, like
 * the bars): `starts`, each day's open from Yahoo's trading periods (pre-market's when the bars
 * include it), and `open`, today's as seconds after midnight. US option contracts trade from
 * 9:30 New York, though Yahoo gives them whole days.
 */
function sessionOpens(m, off, prepost) {
  const option = m.instrumentType === 'OPTION';
  const at = (p) => {
    if (!p || !Number.isFinite(p.start) || (Number.isFinite(p.end) && p.end <= p.start)) return null;
    if (!option) return p.start + off;
    const g = Number.isFinite(p.gmtoffset) ? p.gmtoffset : off;
    return Math.floor((p.start + g) / DAY) * DAY + 9.5 * 3600 - g + off;
  };
  const tp = m.tradingPeriods;
  const lists = Array.isArray(tp) ? [tp] : tp ? [prepost && !option ? tp.pre : null, tp.regular] : [];
  const byDay = new Map(); // chart day → its earliest open
  for (const list of lists) {
    for (const p of Array.isArray(list) ? list.flat() : []) {
      const s = at(p);
      if (s == null) continue;
      const d = Math.floor(s / DAY);
      if (!(byDay.get(d) <= s)) byDay.set(d, s);
    }
  }
  const cur = m.currentTradingPeriod;
  const today = (prepost && !option ? at(cur?.pre) : null) ?? at(cur?.regular);
  return {
    starts: [...byDay.values()].sort((a, b) => a - b),
    open: today == null ? null : ((today % DAY) + DAY) % DAY,
  };
}

function normalizeChart(json, tfCfg) {
  const res = json?.chart?.result?.[0];
  if (!res) throw Object.assign(new Error(json?.chart?.error?.description || 'No data'), { status: 404 });

  const m = res.meta || {};
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const off = m.gmtoffset || 0; // show times in the exchange's local time

  let bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    let t = ts[i] + off;
    if (tfCfg.daily) t = Math.floor(t / DAY) * DAY;
    bars.push({ time: t, open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  bars.sort((a, b) => a.time - b.time);

  // Merge points that are closer together than one bar (Yahoo appends a live/closing point).
  const merged = [];
  for (const b of bars) {
    const prev = merged[merged.length - 1];
    if (prev && b.time - prev.time < tfCfg.spacing) {
      prev.high = Math.max(prev.high, b.high);
      prev.low = Math.min(prev.low, b.low);
      prev.close = b.close;
      prev.volume = Math.max(prev.volume, b.volume);
    } else {
      merged.push({ ...b });
    }
  }
  bars = merged;

  // Yahoo adds a zero-volume "official close" point at the end of a session (e.g. 16:00 for US stocks).
  // Fold it into the session's last real bar instead of showing a flat extra candle.
  if (!tfCfg.daily) {
    bars = bars.filter((b, i) => {
      const prev = bars[i - 1], next = bars[i + 1];
      const isClosePrint = b.volume === 0 && b.open === b.close && b.high === b.low && prev && prev.volume > 0
        && (!next || Math.floor(next.time / DAY) !== Math.floor(b.time / DAY));
      if (!isClosePrint) return true;
      prev.close = b.close;
      prev.high = Math.max(prev.high, b.close);
      prev.low = Math.min(prev.low, b.close);
      return false;
    });
  }

  // Bad prints (mostly pre-market / after-hours) would squash the chart; clip them.
  if (!tfCfg.daily) bars = cleanSpikes(bars);
  // Daily forex bars come with each finished day's close equal to its open: rebuild the closes.
  if (tfCfg.interval === '1d' && m.instrumentType === 'CURRENCY') fixFxDailyCloses(bars);

  // Grouped timeframes restart at each session's open (from Yahoo's trading periods; a day they
  // don't cover starts at its first bar). The chart starts live bars of a new session there too.
  const sess = tfCfg.daily ? null : sessionOpens(m, off, tfCfg.prepost);
  if (tfCfg.aggregate) {
    const anchor = sess.starts.length ? (t) => sessionStart(t, null, sess.starts) : null;
    bars = aggregateSessions(bars, tfCfg.aggregate, { anchor });
  }

  return {
    meta: {
      symbol: m.symbol,
      name: m.longName || m.shortName || m.symbol,
      currency: m.currency || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
      type: m.instrumentType || '',
      precision: Number.isInteger(m.priceHint) ? m.priceHint : 2,
      price: m.regularMarketPrice,
      tzOffset: off,
      sessionOpen: sess?.open ?? null, // seconds after midnight, chart time
    },
    bars,
  };
}

async function yahooChart(symbol, tf, live, prepost = false) {
  const t = parseTf(tf);
  const cfg = t && yahooPlan(t);
  if (!cfg) throw Object.assign(new Error(`Unsupported timeframe ${tf}`), { status: 400 });
  // prepost: also pre-market and after-hours bars (intraday only; daily bars are the regular session).
  const params = new URLSearchParams({ interval: cfg.interval, includePrePost: prepost && !cfg.daily ? 'true' : 'false' });
  if (live) params.set('range', cfg.live);
  else if (cfg.full) { params.set('period1', '0'); params.set('period2', String(Math.floor(Date.now() / 1000))); }
  else params.set('range', cfg.range);
  // Round period2 so the cache key stays stable for a minute.
  if (params.has('period2')) params.set('period2', String(Math.floor(Date.now() / 60000) * 60));
  // Yahoo keeps an option contract's intraday history only as 1-minute bars (the last 7 days):
  // build other intraday timeframes from those. A contract's symbol (underlying, yymmdd, C/P,
  // strike × 1000: "SPY261204C00690000") goes there straight away, as its own interval is always empty.
  const fromMinutes = !cfg.daily && cfg.interval !== '1m';
  const minutes = async () => {
    const one = new URLSearchParams({ interval: '1m', range: live ? '1d' : '7d', includePrePost: 'false' });
    const size = cfg.aggregate || cfg.spacing;
    const minute = await yahooGet(`/v8/finance/chart/${encodeURIComponent(symbol)}?${one}`, live ? 8000 : 60000);
    return normalizeChart(minute, { spacing: 60, aggregate: size > 60 ? size : 0 });
  };
  if (fromMinutes && /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/.test(symbol)) return minutes();
  const json = await yahooGet(`/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, live ? 8000 : 60000);
  const out = normalizeChart(json, { ...cfg, prepost: prepost && !cfg.daily });
  if (fromMinutes && !out.bars.length && out.meta.type === 'OPTION') return { ...out, bars: (await minutes()).bars };
  if (!live && !cfg.aggregate) return freshenTail(symbol, cfg, json, out, prepost);
  return out;
}

/**
 * Yahoo sometimes answers a long history with an old copy that ends weeks or months back, while the
 * market has traded since (issue #7: MSFT daily ending in 2025). The live refresh then glued this
 * week's bars straight onto it. When the last bar is well behind the latest trade, fetch the recent
 * part on its own (a different request, so a fresh copy) and put it in place of the old tail.
 */
async function freshenTail(symbol, cfg, json, out, prepost) {
  const marketTime = json?.chart?.result?.[0]?.meta?.regularMarketTime;
  const last = out.bars[out.bars.length - 1];
  if (!last) return out;
  const lastUtc = last.time - (out.meta.tzOffset || 0);
  if (!isStaleHistory(lastUtc, marketTime, cfg.spacing)) return out;
  try {
    const p = new URLSearchParams({
      interval: cfg.interval, includePrePost: prepost && !cfg.daily ? 'true' : 'false',
      period1: String(Math.floor(lastUtc - 10 * DAY)), period2: String(Math.floor(Date.now() / 60000) * 60),
    });
    const fresh = normalizeChart(await yahooGet(`/v8/finance/chart/${encodeURIComponent(symbol)}?${p}`, 60000), { ...cfg, prepost: prepost && !cfg.daily });
    if (!fresh.bars.length || fresh.bars[fresh.bars.length - 1].time <= last.time) return out;
    return { ...out, bars: spliceFreshTail(out.bars, fresh.bars) };
  } catch {
    return out; // the old copy is still better than nothing; the chart refuses to glue across the gap
  }
}

/** Last price, previous close and name for many symbols (Yahoo's spark endpoint, 20 per request). */
async function yahooQuotes(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  const results = await Promise.allSettled(chunks.map(async (chunk) => {
    const json = await yahooGet(`/v7/finance/spark?symbols=${encodeURIComponent(chunk.join(','))}&range=1d&interval=1d`, 15000);
    return (json.spark?.result || []).map((r) => {
      const m = r.response?.[0]?.meta || {};
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose;
      return {
        symbol: r.symbol,
        name: m.shortName || m.longName || r.symbol,
        price,
        prevClose: prev ?? null,
        change: prev ? ((price - prev) / prev) * 100 : null,
        precision: Number.isInteger(m.priceHint) ? m.priceHint : 2,
        exchange: m.fullExchangeName || m.exchangeName || '',
      };
    });
  }));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((q) => Number.isFinite(q.price));
}

const SCREENERS = new Set([
  'day_gainers', 'day_losers', 'most_actives', 'small_cap_gainers', 'undervalued_growth_stocks',
  'growth_technology_stocks', 'undervalued_large_caps', 'aggressive_small_caps', 'most_shorted_stocks',
  'top_mutual_funds', 'portfolio_anchors', 'solid_large_growth_funds', 'conservative_foreign_funds', 'high_yield_bond',
]);

/** Yahoo's predefined stock screens, plus 'trending'. */
async function yahooScreener(id) {
  if (id === 'trending') {
    const json = await yahooGet('/v1/finance/trending/US?count=25', 120000);
    const symbols = (json.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
    return yahooQuotes(symbols);
  }
  if (!SCREENERS.has(id)) throw Object.assign(new Error('Unknown screener'), { status: 400 });
  const json = await yahooGet(`/v1/finance/screener/predefined/saved?scrIds=${id}&count=50`, 120000);
  return (json.finance?.result?.[0]?.quotes || []).map((q) => ({
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: q.regularMarketChangePercent,
    precision: Number.isInteger(q.priceHint) ? q.priceHint : 2,
    exchange: q.fullExchangeName || '',
  })).filter((q) => q.symbol && Number.isFinite(q.price));
}

async function yahooSearch(q) {
  const params = new URLSearchParams({ q, quotesCount: '25', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' });
  const json = await yahooGet(`/v1/finance/search?${params}`, 300000);
  return (json.quotes || [])
    .filter((x) => x.symbol && x.quoteType !== 'OPTION')
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      exchange: x.exchDisp || x.exchange || '',
      type: x.typeDisp || x.quoteType || '',
      quoteType: x.quoteType || '',
    }));
}

// ---------------------------------------------------------------------------
// Full market lists: every US-listed stock and ETF (from Nasdaq's public screener)
// ---------------------------------------------------------------------------

const UNIVERSE_TTL = 10 * 60 * 1000;
const universeCache = new Map();

async function loadUniverse(id) {
  const hit = universeCache.get(id);
  if (hit && Date.now() - hit.t < UNIVERSE_TTL) return hit;
  try {
    const rows = await fetchUsList(id);
    const entry = { t: Date.now(), rows, body: gzipSync(JSON.stringify(rows)) };
    universeCache.set(id, entry);
    return entry;
  } catch (e) {
    if (hit) return hit; // serve the last good copy
    throw Object.assign(new Error(`Couldn't load the market list: ${e.message}`), { status: 502 });
  }
}
const universe = async (id) => (await loadUniverse(id)).body;

// ---------------------------------------------------------------------------
// Stock screener (lib/screener.mjs): Yahoo quote data for the largest US stocks (or another
// market's, from the heatmap's lists), plus
// trend metrics (RSI, momentum, moving-average crosses) from a year of daily closes,
// computed in the background and kept for a few hours.
// ---------------------------------------------------------------------------

const SCREENER_SIZE = 3000; // stocks covered, largest by market cap
const TECH_SIZE = 1500; // how many of them get the trend metrics
const TECH_TTL = 6 * 3600 * 1000;
const QUOTE_FIELDS = [
  'shortName', 'regularMarketPrice', 'regularMarketChangePercent', 'regularMarketVolume', 'regularMarketOpen',
  'regularMarketPreviousClose', 'averageDailyVolume10Day', 'averageDailyVolume3Month', 'marketCap', 'fiftyDayAverage',
  'twoHundredDayAverage', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'fiftyTwoWeekChangePercent', 'trailingPE',
  'earningsTimestamp', 'earningsTimestampStart', 'averageAnalystRating', 'preMarketChangePercent', 'postMarketChangePercent', 'marketState',
].join(',');

// Yahoo's quote endpoint needs a session cookie and a "crumb" token, fetched the way a browser does.
let yahooSession = null;
async function getYahooSession(force = false) {
  if (!force && yahooSession && Date.now() - yahooSession.t < 6 * 3600 * 1000) return yahooSession;
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('No Yahoo session');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(10000),
  });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40 || /[<{\s]/.test(crumb)) throw new Error('No Yahoo crumb');
  yahooSession = { cookie, crumb, t: Date.now() };
  return yahooSession;
}

async function yahooQuoteBatch(symbols, retry = true) {
  const sess = await getYahooSession();
  const q = new URLSearchParams({ symbols: symbols.join(','), fields: QUOTE_FIELDS, crumb: sess.crumb });
  const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?${q}`, {
    headers: { 'User-Agent': UA, Cookie: sess.cookie }, signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await getYahooSession(true); return yahooQuoteBatch(symbols, false); }
  if (!r.ok) throw new Error(`Yahoo quotes HTTP ${r.status}`);
  return (await r.json()).quoteResponse?.result || [];
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const quoteCaches = new Map(); // market -> { t, map, ok }
async function screenerQuotes(market, symbols) {
  const hit = quoteCaches.get(market);
  if (hit && Date.now() - hit.t < 60000) return hit;
  const map = new Map();
  await mapLimit(chunks(symbols, 200), 3, async (batch) => {
    try { for (const q of await yahooQuoteBatch(batch)) map.set(q.symbol, q); } catch { /* leave these out */ }
  });
  if (!map.size && hit?.map.size) return hit; // keep the last good data
  const entry = { t: Date.now(), map, ok: map.size > 0 };
  quoteCaches.set(market, entry);
  return entry;
}

const techCache = new Map(); // symbol -> { t, tech }
const techJobs = new Map(); // market -> its running job (each market's metrics fill in on their own)
function refreshTechnicals(market, symbols) {
  if (techJobs.has(market)) return;
  const stale = symbols.filter((sym) => !(techCache.get(sym)?.t > Date.now() - TECH_TTL));
  if (!stale.length) return;
  techJobs.set(market, mapLimit(chunks(stale, 20), 2, async (batch) => {
    for (const host of YAHOO_HOSTS) {
      try {
        const r = await fetch(`https://${host}/v7/finance/spark?symbols=${encodeURIComponent(batch.join(','))}&range=1y&interval=1d`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) continue;
        for (const x of (await r.json()).spark?.result || []) {
          const closes = x.response?.[0]?.indicators?.quote?.[0]?.close || [];
          techCache.set(x.symbol, { t: Date.now(), tech: technicals(closes) });
        }
        return;
      } catch { /* try the other host */ }
    }
  }).finally(() => { techJobs.delete(market); }));
}

/** The screener's markets: 'us' (Nasdaq's full list), or a stock market of the heatmap (its largest companies). */
const isScreenerMarket = (m) => m === 'us' || (Object.hasOwn(HEATMAP_MARKETS, m) && m !== 'crypto');

const screenerCache = new Map(); // market -> { t, body }
async function screener(market = 'us') {
  const hit = screenerCache.get(market);
  if (hit && Date.now() - hit.t < 30000) return hit.body;
  let top, money = {};
  if (market === 'us') {
    const { rows: all } = await loadUniverse('us-stocks');
    top = all.filter((r) => r.m > 0 && r.p > 0).sort((a, b) => b.m - a.m).slice(0, SCREENER_SIZE);
  } else {
    const list = await marketStocks(market, { getYahooSession, getUsCountries });
    top = list.rows;
    // Prices and caps stay in the market's currency; fx (dollars per unit) lets the size filter work in dollars.
    money = { cur: list.cur, capCur: list.capCur, fx: (await fxRates())[list.capCur] ?? null };
  }
  const symbols = top.map((r) => r.s);
  refreshTechnicals(market, symbols.slice(0, TECH_SIZE));
  const quotes = await screenerQuotes(market, symbols);
  const now = Date.now() / 1000;
  const rows = top.map((b) => {
    const row = buildRow(b, quotes.map.get(b.s), techCache.get(b.s)?.tech, now);
    if (market !== 'us' && b.n) row.n = b.n; // the list's full names (Yahoo's short ones abroad are often cut or in capitals)
    return row;
  });
  const info = insights(rows);
  for (const r of rows) { delete r.sma50; delete r.sma200; delete r.hi52; delete r.lo52; delete r.hi20; delete r.lo20; }
  const techTotal = Math.min(TECH_SIZE, symbols.length);
  const body = gzipSync(JSON.stringify({
    updated: Date.now(),
    market,
    ...money,
    limited: !quotes.ok, // only the basic list data (Yahoo's quote data was unavailable)
    tech: { done: symbols.slice(0, techTotal).filter((sym) => techCache.has(sym)).length, total: techTotal },
    insights: info,
    rows,
  }));
  screenerCache.set(market, { t: Date.now(), body });
  return body;
}

// ---------------------------------------------------------------------------
// News and calendar (lib/news.mjs, lib/calendar.mjs, lib/markets.mjs): headlines from public RSS
// feeds ranked by how "hot" they are, for the US and other regions, plus economic releases for
// about 60 countries, Fed decisions and earnings in 18 stock markets. Nothing is fetched unless
// the News panel asks for it.
// ---------------------------------------------------------------------------

const NEWS_FEEDS = [
  { id: 'cnbc-top', region: 'us', source: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', weight: 1.1 },
  { id: 'cnbc-markets', region: 'us', source: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', weight: 1.1 },
  { id: 'cnbc-earnings', region: 'us', source: 'CNBC', url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html', weight: 1.1, topic: 'earnings' },
  { id: 'marketwatch', region: 'us', source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', weight: 1 },
  { id: 'nasdaq', region: 'us', source: 'Nasdaq', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets', weight: 0.8 },
  { id: 'investing', region: 'us', source: 'Investing.com', url: 'https://www.investing.com/rss/news.rss', weight: 1 },
  { id: 'investing-stocks', region: 'us', source: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss', weight: 1 },
  { id: 'seekingalpha', region: 'us', source: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', weight: 0.9, tickerCategories: true },
  { id: 'benzinga', region: 'us', source: 'Benzinga', url: 'https://www.benzinga.com/feed', weight: 0.9 },
  { id: 'coindesk', region: 'us', source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', weight: 0.9, topic: 'crypto' },
  { id: 'cointelegraph', region: 'us', source: 'Cointelegraph', url: 'https://cointelegraph.com/rss', weight: 0.8, topic: 'crypto' },
  { id: 'fed', region: 'us', source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', weight: 1.4, topic: 'economy' },
  // United Kingdom
  { id: 'ft-markets', region: 'gb', source: 'Financial Times', url: 'https://www.ft.com/markets?format=rss', weight: 1.1 },
  { id: 'guardian-business', region: 'gb', source: 'The Guardian', url: 'https://www.theguardian.com/uk/business/rss', weight: 1 },
  { id: 'bbc-business', region: 'gb', source: 'BBC', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', weight: 1 },
  { id: 'cityam', region: 'gb', source: 'City A.M.', url: 'https://www.cityam.com/feed/', weight: 0.9 },
  { id: 'sky-business', region: 'gb', source: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/business.xml', weight: 0.9 },
  { id: 'thisismoney', region: 'gb', source: 'This is Money', url: 'https://www.thisismoney.co.uk/money/markets/index.rss', weight: 0.8 },
  { id: 'boe', region: 'gb', source: 'Bank of England', url: 'https://www.bankofengland.co.uk/rss/news', weight: 1.2, topic: 'economy' },
  // Europe
  { id: 'ft-europe', region: 'eu', source: 'Financial Times', url: 'https://www.ft.com/europe?format=rss', weight: 1.1 },
  { id: 'cnbc-europe', region: 'eu', source: 'CNBC', url: 'https://www.cnbc.com/id/19794221/device/rss/rss.html', weight: 1.1 },
  { id: 'irishtimes-business', region: 'eu', source: 'The Irish Times', url: 'https://www.irishtimes.com/arc/outboundfeeds/feed-business/?outputType=xml', weight: 0.8 },
  { id: 'euronews-business', region: 'eu', source: 'Euronews', url: 'https://www.euronews.com/rss?level=vertical&name=business', weight: 0.9 },
  { id: 'dw-business', region: 'eu', source: 'DW', url: 'https://rss.dw.com/rdf/rss-en-bus', weight: 0.9 },
  { id: 'ecb', region: 'eu', source: 'European Central Bank', url: 'https://www.ecb.europa.eu/rss/press.html', weight: 1.2, topic: 'economy' },
  // Asia
  { id: 'cnbc-asia', region: 'asia', source: 'CNBC', url: 'https://www.cnbc.com/id/19832390/device/rss/rss.html', weight: 1.1 },
  { id: 'scmp-business', region: 'asia', source: 'SCMP', url: 'https://www.scmp.com/rss/92/feed', weight: 1 },
  { id: 'scmp-markets', region: 'asia', source: 'SCMP', url: 'https://www.scmp.com/rss/12/feed', weight: 1 },
  { id: 'straitstimes-business', region: 'asia', source: 'The Straits Times', url: 'https://www.straitstimes.com/news/business/rss.xml', weight: 0.9 },
  { id: 'japantoday-business', region: 'asia', source: 'Japan Today', url: 'https://japantoday.com/category/business/feed', weight: 0.8 },
  { id: 'boj', region: 'asia', source: 'Bank of Japan', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml', weight: 1, topic: 'economy' },
  // India
  { id: 'et-markets', region: 'in', source: 'The Economic Times', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', weight: 1 },
  { id: 'mint-markets', region: 'in', source: 'Mint', url: 'https://www.livemint.com/rss/markets', weight: 1 },
  { id: 'bs-markets', region: 'in', source: 'Business Standard', url: 'https://www.business-standard.com/rss/markets-106.rss', weight: 1 },
  // Canada
  { id: 'globe-business', region: 'ca', source: 'The Globe and Mail', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/', weight: 1 },
  { id: 'cbc-business', region: 'ca', source: 'CBC', url: 'https://www.cbc.ca/webfeed/rss/rss-business', weight: 1 },
  { id: 'boc', region: 'ca', source: 'Bank of Canada', url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/', weight: 1.2, topic: 'economy' },
  // Australia
  { id: 'abc-business', region: 'au', source: 'ABC News', url: 'https://www.abc.net.au/news/feed/51892/rss.xml', weight: 1 },
  { id: 'smh-business', region: 'au', source: 'The Sydney Morning Herald', url: 'https://www.smh.com.au/rss/business.xml', weight: 1 },
  { id: 'rba', region: 'au', source: 'Reserve Bank of Australia', url: 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml', weight: 1.2, topic: 'economy' },
  // Worldwide (in "World", next to every region's feeds)
  { id: 'bloomberg-markets', region: 'world', source: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss', weight: 1.2 },
  { id: 'bloomberg-economics', region: 'world', source: 'Bloomberg', url: 'https://feeds.bloomberg.com/economics/news.rss', weight: 1.2, topic: 'economy' },
  { id: 'cnbc-world', region: 'world', source: 'CNBC', url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html', weight: 1.1 },
  { id: 'investing-world', region: 'world', source: 'Investing.com', url: 'https://www.investing.com/rss/news_287.rss', weight: 1 },
  { id: 'investing-economy', region: 'world', source: 'Investing.com', url: 'https://www.investing.com/rss/news_14.rss', weight: 1, topic: 'economy' },
  { id: 'fxstreet', region: 'world', source: 'FXStreet', url: 'https://www.fxstreet.com/rss/news', weight: 0.8 },
];

/**
 * News regions: their feeds (above), the stock markets whose companies their headlines are
 * tagged with (lib/markets.mjs), and the country of Yahoo's "trending" list to show.
 */
const NEWS_REGIONS = {
  world: { markets: MARKET_ORDER, trending: 'US' },
  us: { markets: [], trending: 'US' },
  gb: { markets: ['GB'], trending: 'GB' },
  eu: { markets: ['DE', 'FR', 'NL', 'IT', 'ES', 'CH', 'SE'], trending: 'DE' },
  asia: { markets: ['JP', 'HK', 'CN', 'KR', 'TW'], trending: 'HK' },
  in: { markets: ['IN'], trending: 'IN' },
  ca: { markets: ['CA'], trending: 'CA' },
  au: { markets: ['AU'], trending: 'AU' },
};

/** The news region a chart symbol trades in: "HSBA.L" → 'gb', "NVDA" → 'us'. */
const SUFFIX_REGION = { L: 'gb', DE: 'eu', F: 'eu', PA: 'eu', AS: 'eu', MI: 'eu', MC: 'eu', SW: 'eu', ST: 'eu', T: 'asia', HK: 'asia', SS: 'asia',
  SZ: 'asia', KS: 'asia', KQ: 'asia', TW: 'asia', TWO: 'asia', NS: 'in', BO: 'in', TO: 'ca', V: 'ca', AX: 'au' };
const symbolRegion = (symbol) => SUFFIX_REGION[/\.([A-Z]+)$/.exec(symbol)?.[1]] || 'us';
const FEEDS_BY_ID = Object.fromEntries(NEWS_FEEDS.map((f) => [f.id, f]));
const FEED_TTL = 60 * 1000;
const feedCache = new Map(); // id -> { t, items, etag, modified, error }

async function fetchFeed(feed) {
  const hit = feedCache.get(feed.id);
  if (hit && Date.now() - hit.t < FEED_TTL) return hit;
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' };
  if (hit?.etag) headers['If-None-Match'] = hit.etag;
  if (hit?.modified) headers['If-Modified-Since'] = hit.modified;
  try {
    const r = await fetch(feed.url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.status === 304 && hit) { hit.t = Date.now(); delete hit.error; return hit; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const entry = { t: Date.now(), items: parseFeed(await r.text(), feed), etag: r.headers.get('etag'), modified: r.headers.get('last-modified') };
    feedCache.set(feed.id, entry);
    return entry;
  } catch (e) {
    // Keep the last good headlines; try again after FEED_TTL.
    const entry = { items: [], ...hit, t: Date.now(), error: e.message };
    feedCache.set(feed.id, entry);
    return entry;
  }
}

// Dollars per unit of each currency, for comparing company sizes across markets.
let fxCache = { t: 0, rates: { ...FX_FALLBACK } };
async function fxRates() {
  if (Date.now() - fxCache.t < 3600 * 1000) return fxCache.rates;
  try {
    const rates = { ...fxCache.rates };
    for (const q of await yahooQuoteBatch(Object.keys(FX_FALLBACK).map((c) => `${c}USD=X`))) {
      if (q.regularMarketPrice > 0) rates[q.symbol.slice(0, 3)] = q.regularMarketPrice;
    }
    fxCache = { t: Date.now(), rates };
  } catch { fxCache.t = Date.now() - 55 * 60 * 1000; } // try again in 5 minutes
  return fxCache.rates;
}

// Company → country of its US listings (Nasdaq's list), to spot foreign companies' lines abroad.
let usCo = { t: 0, map: null };
async function getUsCountries() {
  try {
    const u = await loadUniverse('us-stocks');
    if (usCo.t !== u.t) usCo = { t: u.t, map: usCountries(u.rows) };
  } catch { /* can't tell; keep every listing */ }
  return usCo.map;
}

// Yahoo's stock screener (POST form), largest companies first.
async function yahooScreenerQuery(query, retry = true) {
  const sess = await getYahooSession();
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US&formatted=false&crumb=${encodeURIComponent(sess.crumb)}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: sess.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: 250, offset: 0, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', query, userId: '', userIdType: 'guid' }),
    signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await getYahooSession(true); return yahooScreenerQuery(query, false); }
  if (!r.ok) throw new Error(`Yahoo screener HTTP ${r.status}`);
  return (await r.json()).finance?.result?.[0]?.quotes || [];
}
const onExchanges = (ex) => (ex.length > 1
  ? { operator: 'or', operands: ex.map((e) => ({ operator: 'eq', operands: ['exchange', e] })) }
  : { operator: 'eq', operands: ['exchange', ex[0]] });

/** A market's largest companies (its own, not foreign companies' lines there), kept for 12 hours. */
const listingCache = new Map(); // market code -> { t, rows }
async function marketListings(code) {
  const hit = listingCache.get(code);
  if (hit && Date.now() - hit.t < 12 * 3600 * 1000) return hit.rows;
  try {
    const [quotes, fx, us] = await Promise.all([yahooScreenerQuery(onExchanges(MARKETS[code].ex)), fxRates(), getUsCountries()]);
    const rows = shapeListings(quotes, code, { fx, us }).slice(0, 200);
    listingCache.set(code, { t: Date.now(), rows });
    return rows;
  } catch {
    const rows = hit?.rows || [];
    listingCache.set(code, { t: Date.now() - 11 * 3600 * 1000, rows }); // try again in an hour
    return rows;
  }
}

/** The company-name matcher for a news region: US companies plus the region's own. Rebuilt every 10 minutes. */
const nameIndexes = new Map(); // region -> { t, index }
async function getNameIndex(region = 'us') {
  const hit = nameIndexes.get(region);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.index;
  let rows = null;
  try { rows = (await loadUniverse('us-stocks')).rows; } catch { /* tag tickers without US company names */ }
  const markets = NEWS_REGIONS[region]?.markets || [];
  const byCode = {};
  await mapLimit(markets, 4, async (code) => { byCode[code] = await marketListings(code); });
  const local = markets.length ? mergeMarkets(byCode, await getUsCountries()) : [];
  const index = rows || local.length ? buildNameIndex(rows || [], { local }) : hit?.index || null;
  nameIndexes.set(region, { t: rows ? Date.now() : Date.now() - 9 * 60 * 1000, index });
  return index;
}

async function yahooTrending(country = 'US') {
  try {
    const j = await yahooGet(`/v1/finance/trending/${country}?count=25`, 5 * 60 * 1000);
    return (j.finance?.result?.[0]?.quotes || []).map((q) => q.symbol).filter(Boolean);
  } catch { return []; }
}

const cryptoBySymbol = Object.fromEntries(Object.entries(CRYPTO).map(([k, v]) => [v.quote, k]));
const sessionChange = (q, fx) => {
  if (!q) return { c: null, session: null, m: null };
  const m = quoteCapUsd(q, fx) || null;
  if (q.marketState === 'PRE' && Number.isFinite(q.preMarketChangePercent)) return { c: q.preMarketChangePercent, session: 'pre', m };
  return { c: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null, session: null, m };
};

// The day's move for each ticker (stocks: Yahoo symbols; crypto: "BTC" etc.), reusing the
// screener's quotes when they're fresh. Returns { TICKER: { full, c, session, m (market cap in dollars) } }.
const moveCache = new Map(); // yahoo symbol -> { t, q }
async function tickerMoves(tickers) {
  const fx = await fxRates();
  const yahoo = (s) => CRYPTO[s]?.quote || s;
  const now = Date.now();
  // A fresh screener quote from any market it has scanned, else a recent one of our own.
  const screened = (s) => { for (const c of quoteCaches.values()) if (now - c.t < 120000 && c.map.has(s)) return c.map.get(s); return null; };
  const fresh = (s) => screened(s) || (now - (moveCache.get(s)?.t || 0) < 60000 && moveCache.get(s).q);
  const missing = [...new Set(tickers.map(yahoo))].filter((s) => !fresh(s));
  await mapLimit(chunks(missing, 150), 2, async (batch) => {
    try { for (const q of await yahooQuoteBatch(batch)) moveCache.set(q.symbol, { t: Date.now(), q }); } catch { /* no move data for these */ }
  });
  const out = {};
  for (const s of tickers) out[s] = { full: CRYPTO[s]?.full || `YAHOO:${s}`, ...sessionChange(fresh(yahoo(s)) || moveCache.get(yahoo(s))?.q, fx) };
  return out;
}

async function yahooSymbolNews(symbol) {
  const q = CRYPTO[symbol]?.quote || symbol;
  const params = new URLSearchParams({ q, quotesCount: '0', newsCount: '25', listsCount: '0' });
  const j = await yahooGet(`/v1/finance/search?${params}`, 60000);
  return (j.news || []).filter((n) => n.title && /^https?:\/\//.test(n.link || '') && n.providerPublishTime).map((n) => ({
    title: n.title, link: n.link, t: n.providerPublishTime, source: n.publisher || 'Yahoo Finance', feed: 'yahoo', cats: [],
    tickers: [...new Set([symbol, ...(n.relatedTickers || []).map((s) => cryptoBySymbol[s] || s)])],
  }));
}

/**
 * Ranked stories from a region's feeds ('world': all of them), or (symbol) the latest news about
 * one stock or coin from every feed.
 * { updated, region, symbol, stories, trending, quotes: { TICKER: { full, c, session } }, feeds: { ok, total } }
 */
const newsCache = new Map(); // region -> { t, body }
async function news(symbol = '', region = 'us') {
  const hit = !symbol && newsCache.get(region);
  if (hit && Date.now() - hit.t < 20000) return hit.body;
  const feeds = symbol || region === 'world' ? NEWS_FEEDS : NEWS_FEEDS.filter((f) => f.region === region);
  const [entries, index, trendingRaw, own] = await Promise.all([
    Promise.all(feeds.map(fetchFeed)), getNameIndex(symbol ? symbolRegion(symbol) : region),
    symbol ? [] : yahooTrending(NEWS_REGIONS[region].trending), symbol ? yahooSymbolNews(symbol).catch(() => []) : [],
  ]);
  const now = Math.floor(Date.now() / 1000);
  const known = (s) => !!CRYPTO[s] || !!index?.tickers.has(s);
  const trending = trendingRaw.map((s) => cryptoBySymbol[s] || s).filter(known).slice(0, 12);
  const items = [...entries.flatMap((e) => e.items), ...own.map((x) => ({ ...x, tickers: x.tickers.filter((s) => s === symbol || known(s)) }))];
  let stories = buildStories(items, { now, index, feeds: FEEDS_BY_ID, maxAgeH: symbol ? 24 * 7 : 36 });
  if (symbol) stories = stories.filter((s) => s.tickers.includes(symbol));
  stories = stories.slice(0, 400);
  const tickers = [...new Set([...stories.flatMap((s) => s.tickers), ...trending])];
  const quotes = await tickerMoves(tickers);
  const moves = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.c]));
  const caps = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.m]));
  stories = rankStories(stories, { now, moves, caps, trending: new Set(trending) });
  if (symbol) stories.sort((a, b) => b.t - a.t);
  stories = stories.slice(0, 200);
  const used = new Set([...stories.flatMap((s) => s.tickers), ...trending]);
  const body = {
    updated: Date.now(),
    region: symbol ? null : region,
    symbol: symbol || null,
    stories,
    trending,
    quotes: Object.fromEntries(Object.entries(quotes).filter(([s]) => used.has(s)).map(([s, { m, ...q }]) => [s, q])),
    feeds: { ok: entries.filter((e) => !e.error).length, total: feeds.length },
  };
  if (!symbol) newsCache.set(region, { t: Date.now(), body });
  return body;
}

// Yahoo's calendar data (the same that powers its earnings and economic calendars).
async function yahooCalendar(entityIdType, includeFields, operands, sortField, sortType, offset = 0, retry = true) {
  const sess = await getYahooSession();
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/visualization?lang=en-US&region=US&crumb=${encodeURIComponent(sess.crumb)}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: sess.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityIdType, includeFields, sortField, sortType, offset, size: 250, query: { operator: 'and', operands } }),
    signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await getYahooSession(true); return yahooCalendar(entityIdType, includeFields, operands, sortField, sortType, offset, false); }
  if (!r.ok) throw new Error(`Yahoo calendar HTTP ${r.status}`);
  const doc = (await r.json()).finance?.result?.[0]?.documents?.[0];
  if (!doc) return [];
  const cols = doc.columns.map((c) => c.id);
  return doc.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

let fomcCache = { t: 0, events: [] };
async function fomcDecisions() {
  if (Date.now() - fomcCache.t < 24 * 3600 * 1000) return fomcCache.events;
  try {
    const r = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const events = parseFomc(await r.text());
    if (events.length) fomcCache = { t: Date.now(), events };
  } catch { fomcCache.t = Date.now() - 23 * 3600 * 1000; } // try again in an hour
  return fomcCache.events;
}

const ECON_FIELDS = ['econ_release', 'country_code', 'startdatetime', 'period', 'after_release_actual', 'consensus_estimate', 'prior_release_actual', 'originally_reported_actual'];
const EARN_FIELDS = ['ticker', 'companyshortname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct', 'intradaymarketcap'];

/** Economic releases for every country Yahoo covers (a few hundred a week), page by page. */
async function econReleases(range) {
  const rows = [];
  for (let offset = 0; offset < 1500; offset += 250) {
    const page = await yahooCalendar('economic_event', ECON_FIELDS, range, 'startdatetime', 'ASC', offset);
    rows.push(...page);
    if (page.length < 250) break;
  }
  return rows;
}

/** Earnings in the stock markets outside the US (lib/markets.mjs), $1B+ companies, kept 15 minutes. */
let intlEarnCache = { t: 0, rows: [], byCode: {} };
async function intlEarnings(range) {
  if (Date.now() - intlEarnCache.t < 15 * 60 * 1000) return intlEarnCache.rows;
  const [fx, us] = await Promise.all([fxRates(), getUsCountries()]);
  const byCode = {};
  let ok = 0;
  await mapLimit(MARKET_ORDER, 4, async (code) => {
    try {
      const rows = await yahooCalendar('sp_earnings', EARN_FIELDS, [...range, onExchanges(MARKETS[code].ex)], 'intradaymarketcap', 'DESC');
      byCode[code] = shapeIntlEarnings(rows, code, { fx, us });
      ok++;
    } catch { byCode[code] = intlEarnCache.byCode[code] || []; }
  });
  const rows = mergeMarkets(byCode, us).map(({ k, ...r }) => r);
  intlEarnCache = { t: ok ? Date.now() : Date.now() - 14 * 60 * 1000, rows, byCode };
  return rows;
}

/**
 * { updated, econ: [...releases for every country and Fed decisions], earnings: [...$1B+ companies
 * in the US and 17 other markets, m in dollars] } for the past two days and the next nine. Each
 * item has c: its country ("EU": the euro area).
 */
let calendarCache = null;
async function calendar() {
  if (calendarCache && Date.now() - calendarCache.t < 60000) return calendarCache.body;
  const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
  const range = [{ operator: 'gte', operands: ['startdatetime', day(-2)] }, { operator: 'lte', operands: ['startdatetime', day(9)] }];
  const [econ, earn, fomc, list, intl] = await Promise.allSettled([
    econReleases(range),
    yahooCalendar('sp_earnings', EARN_FIELDS, [...range, { operator: 'eq', operands: ['region', 'us'] }], 'intradaymarketcap', 'DESC'),
    fomcDecisions(),
    loadUniverse('us-stocks'),
    intlEarnings(range),
  ]);
  if (econ.status === 'rejected' && earn.status === 'rejected') throw Object.assign(new Error(`Couldn't load the calendar: ${econ.reason?.message}`), { status: 502 });
  const from = Date.now() / 1000 - 2 * 86400, to = Date.now() / 1000 + 9 * 86400;
  const listed = list.status === 'fulfilled' ? new Set(list.value.rows.map((r) => r.s)) : null;
  const fed = (fomc.value || []).filter((e) => e.t >= from && e.t <= to).map((e) => ({ ...e, c: 'US' }));
  // The Fed's own schedule (with projections and the press conference) replaces Yahoo's line for it.
  const yahooFed = (e) => fomc.value?.length && e.c === 'US' && /fomc|fed funds/i.test(e.name);
  const body = {
    updated: Date.now(),
    econ: [...(econ.value ? shapeEcon(econ.value).filter((e) => !yahooFed(e)) : []), ...fed].sort((a, b) => a.t - b.t),
    earnings: [
      ...(earn.value ? shapeEarnings(earn.value, listed, { minCap: 1e9 }).slice(0, 250).map((e) => ({ ...e, c: 'US' })) : []),
      ...(intl.value || []),
    ].sort((a, b) => a.t - b.t || (b.m || 0) - (a.m || 0)),
  };
  calendarCache = { t: Date.now(), body };
  return body;
}

// ---------------------------------------------------------------------------
// Yahoo live prices: one upstream WebSocket, fanned out to browsers over SSE
// ---------------------------------------------------------------------------

const YAHOO_STREAM_URL = 'wss://streamer.finance.yahoo.com/?version=2';

/** Decodes the protobuf "PricingData" message Yahoo sends (only the fields we use). */
function decodePricing(buf) {
  const f = {};
  let i = 0;
  const varint = () => {
    let r = 0n, shift = 0n, b;
    do { b = buf[i++]; r |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80 && i < buf.length);
    return r;
  };
  const zigzag = (v) => Number((v >> 1n) ^ -(v & 1n));
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >>> 3, wire = key & 7;
    if (wire === 0) f[field] = varint();
    else if (wire === 1) { f[field] = buf.readDoubleLE(i); i += 8; }
    else if (wire === 2) { const len = Number(varint()); f[field] = buf.toString('utf8', i, i + len); i += len; }
    else if (wire === 5) { f[field] = buf.readFloatLE(i); i += 4; }
    else break;
  }
  return {
    s: f[1],                                         // symbol
    p: typeof f[2] === 'number' ? Number(f[2].toPrecision(7)) : NaN, // price (sent as float32)
    t: f[3] != null ? zigzag(f[3]) : Date.now(),     // time, ms
    m: f[7] != null ? Number(f[7]) : 0,              // session: 0 pre, 1 regular, 2 post, 3 extended
    v: f[9] != null ? zigzag(f[9]) : undefined,      // day volume
  };
}

class YahooStreamer {
  constructor() {
    this.ws = null;
    this.refs = new Map();   // symbol -> number of subscribed browsers
    this.clients = new Set();
    this.retry = 0;
    this.idleTimer = null;
  }

  attach(client) {
    this.clients.add(client);
    const fresh = [];
    for (const s of client.symbols) {
      const n = this.refs.get(s) || 0;
      this.refs.set(s, n + 1);
      if (!n) fresh.push(s);
    }
    clearTimeout(this.idleTimer);
    if (!this.ws) this.connect();
    else if (fresh.length && this.ws.readyState === 1) this.ws.send(JSON.stringify({ subscribe: fresh }));
  }

  detach(client) {
    if (!this.clients.delete(client)) return;
    const gone = [];
    for (const s of client.symbols) {
      const n = (this.refs.get(s) || 1) - 1;
      if (n <= 0) { this.refs.delete(s); gone.push(s); } else this.refs.set(s, n);
    }
    if (gone.length && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ unsubscribe: gone }));
    if (!this.refs.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.refs.size) return;
        const ws = this.ws;
        this.ws = null;
        ws?.close();
      }, 30000);
    }
  }

  /** Opens the stream again (through a newly set proxy); nothing to do if it isn't open. */
  restart() {
    if (!this.ws) return;
    this.retry = 0;
    this.ws.close(); // onclose reconnects while anyone is watching
  }

  connect() {
    if (typeof WebSocket === 'undefined') return; // Node < 22: fall back to polling only
    const ws = new WebSocket(YAHOO_STREAM_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      if (this.refs.size) ws.send(JSON.stringify({ subscribe: [...this.refs.keys()] }));
    };
    ws.onmessage = (ev) => {
      let tick;
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
        if (!msg.message) return;
        tick = decodePricing(Buffer.from(msg.message, 'base64'));
      } catch {
        return;
      }
      if (!tick.s || !Number.isFinite(tick.p)) return;
      for (const c of this.clients) if (c.symbols.has(tick.s)) c.send(tick);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.refs.size) return;
      setTimeout(() => { if (!this.ws && this.refs.size) this.connect(); }, Math.min(1000 * 2 ** this.retry++, 30000));
    };
    ws.onerror = () => {}; // a close event follows
  }
}

const streamer = new YahooStreamer();
onServerProxyChange(() => streamer.restart());

function handleStream(url, req, res) {
  const symbols = new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    ...CORS,
  });
  res.write('retry: 3000\n\n');
  const client = { symbols, send: (tick) => res.write(`data: ${JSON.stringify(tick)}\n\n`) };
  streamer.attach(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    streamer.detach(client);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// The API carries public market data only, so any site may use it (e.g. a static Wickline
// on GitHub Pages pointed at this server in its settings).
const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

async function handleApi(url, req, res) {
  const p = url.searchParams;
  if (url.pathname === '/api/health') return sendJson(res, 200, { app: 'wickline', version: VERSION, features: ['yahoo', 'stream', 'universe', 'screener', 'stock-screener', 'news', 'calendar'] });
  if (url.pathname === '/api/yahoo/stream') return handleStream(url, req, res);
  try {
    const u = /^\/api\/universe\/(us-stocks|us-etfs)$/.exec(url.pathname);
    if (u) {
      const body = await universe(u[1]);
      res.writeHead(200, {
        'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=300', Vary: 'Accept-Encoding', ...CORS,
      });
      return res.end(body);
    }
    if (url.pathname === '/api/yahoo/chart') {
      const symbol = p.get('symbol');
      if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
      return sendJson(res, 200, await yahooChart(symbol, p.get('tf') || '1D', p.get('live') === '1', p.get('prepost') === '1'));
    }
    if (url.pathname === '/api/yahoo/quotes') {
      const symbols = (p.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
      return sendJson(res, 200, await yahooQuotes(symbols));
    }
    if (url.pathname === '/api/screener') {
      const market = p.get('market') || 'us';
      if (!isScreenerMarket(market)) return sendJson(res, 400, { error: 'Unknown market' });
      const body = await screener(market);
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', ...CORS });
      return res.end(body);
    }
    // The heatmap's other markets (lib/heatmap-markets.mjs): crypto and stock markets outside the US.
    if (url.pathname === '/api/heatmap') {
      const market = p.get('market') || '';
      if (!Object.hasOwn(HEATMAP_MARKETS, market)) return sendJson(res, 400, { error: 'Unknown market' });
      const body = await heatmapMarket(market, { getYahooSession, getUsCountries });
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', ...CORS });
      return res.end(body);
    }
    // Option chains (lib/options.mjs): Yahoo for US stocks and ETFs, Deribit for BTC and ETH.
    if (url.pathname === '/api/options') {
      const q = optionsQuery(p.get('symbol'), p.get('expiry'));
      if (q.error) return sendJson(res, 400, { error: q.error });
      const body = await optionsBody(q, { getYahooSession }); // gzipped JSON, cached per fetched chain
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', ...CORS });
      return res.end(body);
    }
    if (url.pathname === '/api/news') {
      const symbol = (p.get('symbol') || '').trim().toUpperCase();
      const region = p.get('region') || 'us';
      if (symbol && !/^[A-Z0-9.\-^=]{1,12}$/.test(symbol)) return sendJson(res, 400, { error: 'bad symbol' });
      if (!Object.hasOwn(NEWS_REGIONS, region)) return sendJson(res, 400, { error: 'bad region' });
      return sendJson(res, 200, await news(symbol, region));
    }
    if (url.pathname === '/api/calendar') return sendJson(res, 200, await calendar());
    if (url.pathname.startsWith('/api/community/')) {
      const rel = url.pathname.slice('/api/community/'.length);
      if (!isCommunityPath(rel)) return sendJson(res, 404, { error: 'Not found' });
      const { body } = await communityFile(rel);
      res.writeHead(200, {
        // Script code is served as plain text: the app runs it only in its sandboxed worker.
        'Content-Type': rel.endsWith('.json') ? MIME['.json'] : 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...CORS,
      });
      return res.end(body);
    }
    if (url.pathname === '/api/yahoo/screener') {
      return sendJson(res, 200, await yahooScreener(p.get('id') || 'most_actives'));
    }
    if (url.pathname === '/api/yahoo/search') {
      const q = (p.get('q') || '').trim();
      return sendJson(res, 200, q ? await yahooSearch(q) : []);
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    return sendJson(res, e.status || 502, { error: e.message || String(e) });
  }
}

async function serveFile(filePath, res) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // The worker that runs user and community scripts may load only the app's own modules and
      // can't reach the network at all (no fetch, WebSocket or imports from other sites).
      ...(path.basename(filePath) === 'script-worker.js' ? { 'Content-Security-Policy': SCRIPT_WORKER_CSP } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// Nothing a request does may stop the server: in the desktop app it runs inside the app itself.
async function handleRequest(req, res) {
  try {
    await routeRequest(req, res);
  } catch {
    try {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
    } catch { /* the connection is already gone */ }
  }
}

async function routeRequest(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleApi(url, req, res);

  let rel;
  try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return sendJson(res, 400, { error: 'Bad path' }); }
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  return serveFile(filePath, res);
}

/** Starts the server (also used by the desktop app). Resolves with the port it listens on. */
export function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}

// `npm start` / `node server.mjs`
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const proxy = envProxy();
  if (proxy.error) console.warn(`Ignoring the proxy "${proxy.text}": ${proxy.error}`);
  if (proxy.url) {
    await setServerProxy(proxy.url);
    console.log(`Connecting through the proxy ${proxy.url.replace(/\/\/[^@/]*@/, '//')}`);
  }
  const { port } = await startServer();
  console.log(`Wickline running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
}
