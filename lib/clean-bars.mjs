// Removes bad prints from intraday bars.
//
// Pre-market and after-hours data (and occasionally regular-session data) contains stray trades
// far from the real price, e.g. a 5-minute AMD bar with a low of 119 while it traded at 610.
// One such wick stretches the price scale until every other candle is a thin line.
//
// A wick (or an open/close) is a bad print when it reaches far beyond the bodies of the
// neighbouring bars, much further than this stretch of data normally moves in one bar. It is
// clipped back to the neighbours' range. Real moves survive: the bars around a genuine jump
// move too, which widens the neighbours' range.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {{time:number, open:number, high:number, low:number, close:number, volume:number}[]} bars
 * @param {{ k?: number, minTol?: number, volMult?: number, skipLast?: number }} [opts]
 *   k: neighbours on each side; minTol: smallest allowed reach beyond them (fraction);
 *   volMult: allowed reach in multiples of the typical bar body; skipLast: newest bars left
 *   alone, since there is nothing after them to compare with yet.
 */
export function cleanSpikes(bars, { k = 5, minTol = 0.02, volMult = 6, skipLast = 2 } = {}) {
  const n = bars.length;
  if (n < 2 * k + 1) return bars;
  // How far bars here normally move, from their bodies (bad prints only touch wicks).
  const rel = bars.map((b) => (b.close > 0 ? Math.abs(b.close - b.open) / b.close : 0));
  const out = bars.map((b) => ({ ...b }));
  for (let i = 0; i < n - skipLast; i++) {
    const a = Math.max(0, i - k), z = Math.min(n - 1, i + k);
    const bodies = [], ranges = [];
    for (let j = a; j <= z; j++) {
      if (j === i) continue;
      bodies.push(bars[j].open, bars[j].close);
      ranges.push(rel[j]);
    }
    // The neighbours' price band, ignoring their two most extreme values on each side, so a
    // bad print in a neighbouring bar doesn't widen the band for this one.
    bodies.sort((x, y) => x - y);
    const trim = bodies.length >= 12 ? 2 : 0;
    const lo = bodies[trim], hi = bodies[bodies.length - 1 - trim];
    ranges.sort((x, y) => x - y);
    const tol = Math.max(minTol, (ranges[ranges.length >> 1] || 0) * volMult);
    const b = out[i];
    const maxOk = hi * (1 + tol), minOk = lo * (1 - tol);
    if (b.open > maxOk || b.open < minOk) b.open = clamp(b.open, lo, hi);
    if (b.close > maxOk || b.close < minOk) b.close = clamp(b.close, lo, hi);
    const top = Math.max(b.open, b.close), bot = Math.min(b.open, b.close);
    if (b.high > Math.max(top, hi) * (1 + tol)) b.high = Math.max(top, hi);
    if (b.low < Math.min(bot, lo) * (1 - tol)) b.low = Math.min(bot, lo);
    b.high = Math.max(b.high, top);
    b.low = Math.min(b.low, bot);
  }
  return out;
}

/**
 * Yahoo's daily forex bars have the right open, high and low, but for every finished day the close
 * is a copy of the open, so a chart of them is all crosses (the day still trading is fine). Forex
 * trades around the clock, so a day's real close is the next day's open: put that back. Only done
 * when the bars really are broken this way (most finished days with a body under 5% of their range),
 * so it stops by itself if Yahoo fixes the data. Changes the bars in place and returns them.
 */
export function fixFxDailyCloses(bars) {
  const done = bars.slice(0, -1);
  if (done.length < 2) return bars; // the live refresh asks for only the last few days: those need it too
  const flat = done.filter((b) => b.high > b.low && Math.abs(b.close - b.open) < 0.05 * (b.high - b.low)).length;
  if (flat < done.length * 0.4) return bars;
  for (let i = 0; i < done.length; i++) {
    const b = bars[i], next = bars[i + 1];
    b.close = next.open;
    b.high = Math.max(b.high, b.close);
    b.low = Math.min(b.low, b.close);
  }
  return bars;
}

/**
 * Whether a history is stale: its last bar starts well before the market's latest trade (Yahoo
 * sometimes serves an old copy of a long history; issue #7 got MSFT daily bars ending a year back).
 * lastBarUtc and marketTime in UTC seconds; spacing: the bar length in seconds. A weekly or monthly
 * bar starts days before its latest trade, and a daily chart has weekends and holidays, so the
 * allowance is a week or a bar and a half, whichever is longer.
 */
export function isStaleHistory(lastBarUtc, marketTime, spacing) {
  if (!Number.isFinite(lastBarUtc) || !Number.isFinite(marketTime)) return false;
  return marketTime - lastBarUtc > Math.max(7 * 86400, 1.5 * spacing);
}

/** A history with its tail replaced by fresher bars: everything from fresh's first bar on comes from fresh. */
export function spliceFreshTail(bars, fresh) {
  if (!fresh?.length) return bars;
  const first = fresh[0].time;
  return bars.filter((b) => b.time < first).concat(fresh);
}
