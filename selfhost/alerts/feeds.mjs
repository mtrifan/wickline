// Price feeds for the alert worker (PLAN §2.5.2, §2.5.5): routes each symbol to its streaming
// source, and runs the per-symbol market-hours, fallback and staleness logic.
//
// For every watched symbol:
//   live      a streamed price arrived within the stale threshold
//   closed    a Yahoo symbol whose market is closed (no 1-minute bar in the last 15 min): silence
//             while closed is not staleness; the market is re-checked every closedPollMs
//   fallback  the stream has been silent past the threshold while the market is open (crypto is
//             always open): the REST price is polled every pollMs and evaluated like a tick
//   stale     no price at all (stream or REST) within the threshold while open: reported, and one
//             stale notice per episode. No alert can fire from it, since there is no new price.
// Thresholds: staleAfter.crypto (default 5 min), staleAfter.equity (default 10 min).

const OPEN_RECHECK_MS = 5 * 60_000; // how long an "open" market answer is trusted without ticks
const PROBES_PER_STEP = 2; // market checks started per step, so a restart does not burst requests

export const MARKETS = ['YAHOO', 'BINANCE', 'BINANCEF', 'COINBASE'];
const CRYPTO = new Set(['BINANCE', 'BINANCEF', 'COINBASE']);

/** "YAHOO:AAPL" -> { market: 'YAHOO', ticker: 'AAPL' }; null for a provider no source serves. */
export function route(symbol) {
  const i = symbol.indexOf(':');
  const market = i < 0 ? 'YAHOO' : symbol.slice(0, i).toUpperCase();
  const ticker = i < 0 ? symbol : symbol.slice(i + 1);
  return MARKETS.includes(market) && ticker ? { market, ticker } : null;
}

/**
 * createFeeds({ sources, rest, onPrice, onStale, pollMs, closedPollMs, staleAfter, now, log })
 *   sources   { YAHOO, BINANCE, BINANCEF, COINBASE }: each { setSymbols(tickers), close(), status() }
 *   rest      { prices(market, tickers) -> Map(ticker -> price), marketOpen(ticker) -> boolean }
 *   onPrice   ({ symbol, price, session, at, source }) for every streamed or polled price
 *   onStale   (symbol, since) once at the start of each stale episode
 * Streamed ticks must be passed to tick(); step() runs the schedule (call it every few seconds).
 */
export function createFeeds({ sources, rest, onPrice, onStale = () => {}, pollMs = 30_000, closedPollMs = 15 * 60_000, staleAfter = { crypto: 5 * 60_000, equity: 10 * 60_000 }, now = Date.now, log }) {
  const symbols = new Map(); // "MARKET:TICKER" -> state
  const backoffUntil = Object.fromEntries(MARKETS.map((m) => [m, 0]));
  const polling = new Set(); // markets with a poll in flight
  let probing = 0;

  const keyOf = (market, ticker) => `${market}:${ticker}`;

  /** Watches exactly these (normalized) symbols. Returns the ones no source serves. */
  function setSymbols(list) {
    const unsupported = [];
    const want = new Map();
    for (const s of list) {
      const r = route(s);
      if (r) want.set(keyOf(r.market, r.ticker), r); else unsupported.push(s);
    }
    for (const k of symbols.keys()) if (!want.has(k)) symbols.delete(k);
    const t = now();
    for (const [k, r] of want) {
      if (!symbols.has(k)) {
        symbols.set(k, { ...r, key: k, crypto: CRYPTO.has(r.market), addedAt: t, lastTickAt: null, lastPriceAt: null, lastPollAt: 0, open: CRYPTO.has(r.market) ? true : null, openCheckedAt: 0, probing: false, staleSince: null, pollError: null });
      }
    }
    for (const m of MARKETS) sources[m]?.setSymbols([...want.values()].filter((r) => r.market === m).map((r) => r.ticker));
    return unsupported;
  }

  /** A streamed price. */
  function tick(t) {
    const r = route(t.symbol);
    const st = r && symbols.get(keyOf(r.market, r.ticker));
    if (st) {
      st.lastTickAt = st.lastPriceAt = t.at;
      st.staleSince = null;
      if (!st.crypto) { st.open = true; st.openCheckedAt = t.at; }
    }
    onPrice({ ...t, source: 'stream' });
  }

  const threshold = (st) => (st.crypto ? staleAfter.crypto : staleAfter.equity);

  function stateOf(st, t) {
    if (t - (st.lastTickAt ?? st.addedAt) < threshold(st)) return st.lastTickAt ? 'live' : 'starting';
    if (st.open === false) return 'closed';
    if (st.open === null) return 'checking';
    return t - (st.lastPriceAt ?? st.addedAt) < threshold(st) ? 'fallback' : 'stale';
  }

  async function probe(st) {
    st.probing = true;
    probing++;
    try {
      st.open = !!(await rest.marketOpen(st.ticker));
    } catch (e) {
      st.open = st.open ?? true; // unknown: assume open, so the fallback still runs
      log?.debug?.('market check failed', { symbol: st.key, error: e?.message });
    } finally {
      st.openCheckedAt = now();
      st.probing = false;
      probing--;
    }
  }

  async function poll(market, list) {
    polling.add(market);
    const t0 = now();
    for (const st of list) st.lastPollAt = t0;
    try {
      const prices = await rest.prices(market, list.map((s) => s.ticker));
      const t = now();
      for (const st of list) {
        const price = prices.get(st.ticker);
        if (!Number.isFinite(price)) { st.pollError = 'no price'; continue; }
        st.pollError = null;
        if (symbols.get(st.key) !== st) continue; // no longer watched
        st.lastPriceAt = t;
        st.staleSince = null;
        onPrice({ symbol: st.key, price, session: 1, at: t, source: 'poll' });
      }
    } catch (e) {
      if (e?.waitMs) backoffUntil[market] = now() + e.waitMs;
      for (const st of list) st.pollError = e?.message || String(e);
      log?.debug?.('price fallback failed', { market, error: e?.message });
    } finally {
      polling.delete(market);
    }
  }

  /** Runs one round of the schedule: market checks, fallback polls, stale episodes. */
  function step() {
    const t = now();
    const due = new Map(MARKETS.map((m) => [m, []]));
    for (const st of symbols.values()) {
      if (t - (st.lastTickAt ?? st.addedAt) < threshold(st)) continue; // live (or just added)
      if (!st.crypto && !st.probing) {
        const age = t - st.openCheckedAt;
        if ((st.open === null || age > (st.open ? OPEN_RECHECK_MS : closedPollMs)) && probing < PROBES_PER_STEP) probe(st);
      }
      if (st.open !== true) { st.staleSince = null; continue; }
      if (t - st.lastPollAt >= pollMs) due.get(st.market).push(st);
      if (stateOf(st, t) === 'stale' && st.staleSince == null) {
        st.staleSince = t;
        try { onStale(st.key, t); } catch (e) { log?.error?.('stale notice failed', { error: e?.message }); }
      }
    }
    for (const [market, list] of due) {
      if (!list.length || polling.has(market) || t < backoffUntil[market]) continue;
      poll(market, market === 'YAHOO' ? list.slice(0, 200) : list);
    }
  }

  function status() {
    const t = now();
    const list = [...symbols.values()].map((st) => ({
      symbol: st.key,
      state: stateOf(st, t),
      lastPriceAgoSec: st.lastPriceAt ? Math.round((t - st.lastPriceAt) / 1000) : null,
      ...(st.pollError ? { fallbackError: st.pollError } : {}),
    }));
    const count = (s) => list.filter((x) => x.state === s).length;
    return {
      sources: Object.fromEntries(MARKETS.map((m) => [m, sources[m]?.status?.() ?? null])),
      live: count('live'),
      fallback: count('fallback'),
      stale: count('stale'),
      closed: count('closed'),
      symbolStates: list,
    };
  }

  function close() { for (const m of MARKETS) sources[m]?.close(); }

  return { setSymbols, tick, step, status, close };
}
