// Timeframes: any number of minutes (1–1440) or hours (1–24), plus D, W and M.
// Ids are short and stable because workspaces and links save them: 1m 45m 1h 4h 1D 1W 1M.
// Plain numbers mean minutes (60 → 1h, 240 → 4h). Lower-case m is minutes, upper-case M months.
//
// Each data source has its own fixed list of intervals. A timeframe a source doesn't have is
// built from the largest of its intervals that divides it (10m from 5m, 3h from 1h) and the
// bars are grouped here. Pure functions with no browser APIs: the server and tests use them too
// (i18n.js is English there).

import { t } from './i18n.js';

const DAY = 86400;
const MONTH_SEC = 2629800; // an average month, for spacing and countdowns

const NAMES = { m: 'tf.minutes', h: 'tf.hours', D: 'tf.days', W: 'tf.weeks', M: 'tf.months' }; // "45 minutes", "1 hour"
const SECONDS = { m: 60, h: 3600, D: DAY, W: 7 * DAY, M: MONTH_SEC };

/** The timeframe of n units (m, h, D, W or M) in its canonical form, or null if it isn't one. */
export function makeTf(n, unit) {
  if (!Number.isInteger(n) || n < 1 || !SECONDS[unit]) return null;
  if (unit === 'm') {
    if (n > 1440) return null;
    if (n % 60 === 0) return makeTf(n / 60, 'h'); // 60 → 1h, 240 → 4h
  }
  if (unit === 'h') {
    if (n > 24) return null;
    if (n === 24) return makeTf(1, 'D');
  }
  if ((unit === 'D' || unit === 'W' || unit === 'M') && n !== 1) return null; // no 2D, 2W, 3M (yet)
  const daily = unit === 'D' || unit === 'W' || unit === 'M';
  return {
    id: `${n}${unit}`,
    n,
    unit,
    sec: n * SECONDS[unit],
    daily,
    label: daily ? unit : `${n}${unit === 'h' ? 'H' : 'm'}`, // header button: 45m, 4H, D, W, M
    long: t(NAMES[unit], { n }), // 45 minutes, 1 hour
  };
}

const UNIT_WORDS = {
  min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'D', day: 'D', days: 'D',
  w: 'W', wk: 'W', wks: 'W', week: 'W', weeks: 'W',
  mo: 'M', mon: 'M', mos: 'M', mth: 'M', month: 'M', months: 'M',
};

/**
 * A typed timeframe → timeframe, or null. '45' and '45m' are 45 minutes, '4h' / '4H' 4 hours,
 * 'D' / '1D' a day, 'W' a week, 'M' / '1M' a month (but '1m' a minute).
 */
export function parseTf(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const m = /^(\d{0,4})([a-zA-Z]{0,7})$/.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const word = m[2];
  let unit;
  if (!word) unit = m[1] ? 'm' : null;
  else if (word === 'm') unit = 'm';
  else if (word === 'M') unit = 'M';
  else unit = UNIT_WORDS[word.toLowerCase()] || null;
  return unit ? makeTf(n, unit) : null;
}

const cache = new Map();
/** Timeframe for a saved id (1 hour if it isn't one). Called on every live tick, so cached. */
export function tfById(id) {
  let tf = cache.get(id);
  if (!tf) {
    tf = parseTf(id) || makeTf(1, 'h');
    if (cache.size > 200) cache.clear();
    cache.set(id, tf);
  }
  return tf;
}

/** Canonical id for a typed or saved timeframe, or null. */
export const tfIdOf = (text) => parseTf(text)?.id || null;

/** The common timeframes, grouped as in the header's ▾ menu. */
export const TF_GROUPS = [
  { title: t('tf.group.minutes'), ids: ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m'] },
  { title: t('tf.group.hours'), ids: ['1h', '2h', '3h', '4h', '6h', '8h', '12h'] },
  { title: t('tf.group.days'), ids: ['1D', '1W', '1M'] },
];

// ---------------------------------------------------------------------------
// Each source's own intervals (our id → the source's name for it)
// ---------------------------------------------------------------------------

export const NATIVE = {
  binance: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1D': '1d', '1W': '1w', '1M': '1M' },
  coinbase: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1D': 86400 }, // granularity in seconds
  bybit: { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1D': 'D', '1W': 'W', '1M': 'M' },
  // OKX's 6h and longer bars default to Hong Kong time; the "utc" ones start at 00:00 UTC like everyone else's.
  okx: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1D': '1Dutc', '1W': '1Wutc', '1M': '1Mutc' },
  // Not Yahoo's 90m: it restarts at the open and close (8:30, 9:30 … 15:30, 16:00), which the
  // server's merging of close points would fold together. 90m from 30m has the same 60 days.
  yahoo: { '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1D': '1d', '1W': '1wk', '1M': '1mo' },
  twelvedata: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '45m': '45min', '1h': '1h', '2h': '2h', '4h': '4h', '8h': '8h', '1D': '1day', '1W': '1week', '1M': '1month' },
};

// Days of intraday history Yahoo serves per interval: 1m about a week, hourly two years, the
// rest 60 days. A deeper interval wins over a larger one (6m from 2m, not 1m).
const YAHOO_DAYS = { '1m': 7, '1h': 730 };
const yahooDays = (base) => YAHOO_DAYS[base.id] ?? 60;

/**
 * How to load a timeframe from a source: its own interval when it has it, else the largest of
 * its intervals that divides the timeframe (W and M from days), with the bars grouped.
 * Returns { base, native, factor, agg } where agg is null (no grouping), seconds, 'W' or 'M'.
 */
export function basePlan(tf, source) {
  const natives = NATIVE[source];
  if (natives[tf.id] != null) return { base: tf, native: natives[tf.id], factor: 1, agg: null };
  if (tf.daily) {
    const base = makeTf(1, 'D');
    return { base, native: natives['1D'], factor: tf.unit === 'W' ? 7 : 30, agg: tf.unit };
  }
  const rank = source === 'yahoo' ? yahooDays : () => 0;
  let best = null;
  for (const id of Object.keys(natives)) {
    const b = parseTf(id);
    if (!b || b.daily || tf.sec % b.sec) continue;
    if (!best || rank(b) > rank(best) || (rank(b) === rank(best) && b.sec > best.sec)) best = b;
  }
  return { base: best, native: natives[best.id], factor: tf.sec / best.sec, agg: tf.sec };
}

/** Yahoo request settings for a timeframe (used by the server). spacing = base bar length. */
export function yahooPlan(tf) {
  const { base, native, factor } = basePlan(tf, 'yahoo');
  if (tf.daily) {
    const live = { '1D': '5d', '1W': '1mo', '1M': '3mo' }[tf.id];
    return { interval: native, full: true, live, spacing: { '1D': DAY, '1W': 7 * DAY, '1M': 28 * DAY }[tf.id], daily: true };
  }
  return {
    interval: native,
    range: `${yahooDays(base)}d`,
    live: base.sec >= 3600 ? '5d' : '1d', // whole days, so a grouped bar is never cut in half
    spacing: base.sec,
    ...(factor > 1 ? { aggregate: tf.sec } : {}),
  };
}

// ---------------------------------------------------------------------------
// Grouping bars
// ---------------------------------------------------------------------------

/** Groups time-sorted bars by bucket(time) → bucket start. */
export function groupBars(bars, bucket) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = bucket(b.time);
    if (cur && cur.time === t) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      out.push(cur);
    }
  }
  return out;
}

/**
 * Start (UTC seconds) of the bar holding time t on exchanges that keep bars in UTC (crypto):
 * intraday bars restart at 00:00 UTC every day (the same as one long grid
 * for sizes that divide a day), weeks start on Monday, months on the 1st.
 */
export function utcBucket(t, tf) {
  if (tf.unit === 'M') { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  const day = Math.floor(t / DAY);
  if (tf.unit === 'W') return (day - ((((day + 3) % 7) + 7) % 7)) * DAY;
  return day * DAY + Math.floor((t - day * DAY) / tf.sec) * tf.sec;
}

/** Crypto: groups UTC bars into bars of tf. A first bar missing its start (history cut mid-bar) is dropped. */
export function aggregateUtc(bars, tf) {
  if (!bars.length) return [];
  const out = groupBars(bars, (t) => utcBucket(t, tf));
  if (out.length > 1 && out[0].time < bars[0].time) out.shift();
  return out;
}

/**
 * Where the session holding chart time t began: the latest of `starts` (sorted session opens in
 * chart time, e.g. from Yahoo's trading periods) less than a day before t, else the latest time
 * of day `open` (seconds after midnight) at or before t. Null when neither says.
 */
export function sessionStart(t, open = null, starts = null) {
  if (starts?.length) {
    let lo = 0, hi = starts.length; // → the first start after t
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && t - starts[lo - 1] < DAY) return starts[lo - 1];
  }
  if (open == null || !Number.isFinite(open)) return null;
  return Math.floor((t - open) / DAY) * DAY + open;
}

/** The session open (seconds after midnight) seen in intraday bars: the earliest first bar of a day. */
export function guessSessionOpen(bars) {
  let open = null, day = null;
  for (const b of bars) {
    const d = Math.floor(b.time / DAY);
    if (d === day) continue;
    day = d;
    const tod = b.time - d * DAY;
    if (open == null || tod < open) open = tod;
  }
  return open;
}

/**
 * Stocks: groups intraday bars (in exchange time) into bars of `size` seconds that restart with
 * each session, so they line up with its open (9:30, 11:30, 13:30 … for 2h, or from 4:00 with
 * pre-market). anchor(t) says where t's session began (see sessionStart); the first bucket is
 * then kept (unless trimFirst: history cut mid-bucket), even when its first trade came late.
 * Without it, or where it doesn't know, a day starts at its first bar: the first day at the next
 * day's start when that's earlier (history cut mid-day, 24-hour markets), and a first bar
 * missing its start is dropped.
 */
export function aggregateSessions(bars, size, { anchor = null, trimFirst = !anchor } = {}) {
  if (!bars.length) return [];
  const anchors = new Map(); // day number → its first bar's time
  for (const b of bars) {
    const d = Math.floor(b.time / DAY);
    if (!anchors.has(d)) anchors.set(d, b.time);
  }
  const days = [...anchors.keys()];
  if (days.length > 1) {
    const tod = (t) => t - Math.floor(t / DAY) * DAY;
    const first = anchors.get(days[0]), next = anchors.get(days[1]);
    if (tod(next) < tod(first)) anchors.set(days[0], days[0] * DAY + tod(next));
  }
  const bucket = (t) => {
    const a = anchor?.(t) ?? anchors.get(Math.floor(t / DAY));
    return a + Math.floor((t - a) / size) * size;
  };
  const out = groupBars(bars, bucket);
  if (trimFirst && out.length > 1 && out[0].time < bars[0].time) out.shift();
  return out;
}
