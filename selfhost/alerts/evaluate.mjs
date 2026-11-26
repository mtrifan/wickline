// The server-side alert evaluator (PLAN §2.5.3, §2.5.4, §2.5.5 restart). Pure: no I/O, no clock
// except the one passed in, so it runs the same in the worker and in tests.
//
// Upstream semantics (public/js/alerts.js AlertManager.check; a contract test pins them):
//   up     the price was below the level and is now at or above it
//   down   the price was above the level and is now at or below it
//   cross  either
//   the first price after (re-)arming is ignored, a repeated price is ignored, non-finite prices
//   are skipped, and an alert fires once and then stays inactive until re-armed.
//
// Price-chain hygiene: each market session (Yahoo `m`: 0 pre, 1 regular, 2 post, 3 extended) keeps
// its own previous price, so a jump between sessions (yesterday's close to this morning's
// pre-market) never counts as a crossing. With extendedHours off only regular-session ticks count.

/** Upstream's crossing rule for one alert, given the previous and the current price. */
export function crosses(alert, prev, price) {
  if (prev == null || !Number.isFinite(price) || prev === price) return false;
  const up = prev < alert.price && price >= alert.price;
  const down = prev > alert.price && price <= alert.price;
  return (alert.condition === 'cross' && (up || down)) || (alert.condition === 'up' && up) || (alert.condition === 'down' && down);
}

/** The provider-qualified symbol upstream's quote stream reports: "AAPL" and "YAHOO:AAPL" are one symbol. */
export function normalizeSymbol(symbol) {
  const s = String(symbol ?? '');
  const i = s.indexOf(':');
  if (i < 0) return `YAHOO:${s}`;
  const market = s.slice(0, i).toUpperCase();
  const ticker = s.slice(i + 1);
  // Exchanges report crypto tickers in upper case.
  return `${market}:${['BINANCE', 'BINANCEF', 'COINBASE', 'BYBIT', 'BYBITF', 'OKX', 'OKXF'].includes(market) ? ticker.toUpperCase() : ticker}`;
}

export const REGULAR = 1;

/**
 * Tracks armed alerts and evaluates prices.
 *   extendedHours   evaluate pre/post-market ticks (each session on its own chain)
 *   resumeMaxGapMs  a stored last price younger than this becomes the first previous price after a
 *                   restart (same session only), so a crossing during the downtime fires once
 */
export function createEvaluator({ extendedHours = true, resumeMaxGapMs = 15 * 60_000 } = {}) {
  const alerts = new Map(); // id -> { alert, key, active, chains: Map(session -> { price, at, resumed }) , last }

  /**
   * Replaces the alert list (the parsed `alerts` value). `resume` maps id -> { price, at, session }
   * (stored progress) and is used only for alerts not tracked yet. `now` is for the resume gap.
   */
  function setAlerts(items, { resume = null, now = Date.now() } = {}) {
    const seen = new Set();
    for (const a of Array.isArray(items) ? items : []) {
      if (!a || typeof a.id !== 'string' || !Number.isFinite(Number(a.price))) continue;
      seen.add(a.id);
      const alert = { id: a.id, symbol: a.symbol, condition: a.condition, price: Number(a.price) };
      const active = a.active === true;
      const cur = alerts.get(a.id);
      if (!cur) {
        const st = { alert, key: normalizeSymbol(a.symbol), active, chains: new Map(), last: null };
        const r = resume?.[a.id];
        if (active && r && Number.isFinite(r.price) && Number.isFinite(r.at) && now - r.at <= resumeMaxGapMs && now >= r.at) {
          st.chains.set(r.session ?? REGULAR, { price: r.price, at: r.at, resumed: true });
          st.last = { price: r.price, at: r.at, session: r.session ?? REGULAR };
        }
        alerts.set(a.id, st);
        continue;
      }
      // Re-armed: the first price is ignored, like upstream; nothing from before it is a resume point.
      if (active && !cur.active) { cur.chains.clear(); cur.last = null; }
      if (normalizeSymbol(a.symbol) !== cur.key) { cur.key = normalizeSymbol(a.symbol); cur.chains.clear(); cur.last = null; }
      cur.alert = alert;
      cur.active = active;
    }
    for (const id of alerts.keys()) if (!seen.has(id)) alerts.delete(id);
  }

  /** The symbols with at least one armed alert. */
  function symbols() {
    return [...new Set([...alerts.values()].filter((s) => s.active).map((s) => s.key))];
  }

  /**
   * A price for `symbol` (normalized). Returns the alerts it fires: [{ id, price, at, gap }], where
   * `gap` means the previous price was the one stored before a restart. Fired alerts become
   * inactive here at once, so a following tick cannot fire them again before the list updates.
   */
  function tick({ symbol, price, session = REGULAR, at = Date.now() }) {
    if (!Number.isFinite(price)) return [];
    if (!extendedHours && session !== REGULAR) return [];
    const key = normalizeSymbol(symbol);
    const fired = [];
    for (const st of alerts.values()) {
      if (!st.active || st.key !== key) continue;
      const prev = st.chains.get(session);
      st.chains.set(session, { price, at, resumed: false });
      st.last = { price, at, session };
      if (prev && crosses(st.alert, prev.price, price)) {
        st.active = false;
        fired.push({ id: st.alert.id, price, at, gap: !!prev.resumed });
      }
    }
    return fired;
  }

  /** The latest price seen per alert, for resuming after a restart: id -> { price, at, session }. */
  function progress() {
    const out = {};
    for (const [id, st] of alerts) if (st.active && st.last && !st.chains.get(st.last.session)?.resumed) out[id] = st.last;
    return out;
  }

  return { setAlerts, symbols, tick, progress, get size() { return alerts.size; } };
}
