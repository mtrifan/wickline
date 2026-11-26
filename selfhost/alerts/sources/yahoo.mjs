// Yahoo prices for the alert worker (PLAN §2.5.2): reads upstream's own relay,
// GET /api/yahoo/stream?symbols=…, over loopback, so all of upstream's Yahoo logic is reused.
// Upstream takes at most 100 symbols per stream, so symbols are sharded. Each shard reconnects
// with exponential backoff. The relay pings every 20 s; a connection silent for SILENCE_MS (pings
// included) is dead and is reopened. Pings keep a stream alive even when Yahoo itself has gone
// quiet: detecting that (staleness) is the REST fallback's job (PLAN §2.5.5).
//
// Ticks: { s: "AAPL", p: price, t: time ms, m: session (0 pre, 1 regular, 2 post, 3 extended) }.

import { assignShards } from './shards.mjs';

export const MAX_PER_STREAM = 100;
const SILENCE_MS = 60_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** The Yahoo ticker of an alert symbol, or null if another provider serves it. */
export function yahooTicker(symbol) {
  const s = String(symbol ?? '');
  const i = s.indexOf(':');
  if (i < 0) return s || null;
  return s.slice(0, i).toUpperCase() === 'YAHOO' ? s.slice(i + 1) || null : null;
}

/** Parses an SSE byte stream; calls onData(text) for each `data:` event. Returns a push(chunk) function. */
export function sseParser(onData) {
  let buf = '';
  let data = [];
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { if (data.length) { onData(data.join('\n')); data = []; } continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        data.push(line.slice(line[5] === ' ' ? 6 : 5));
        if (data.length > 1000) data = []; // an event that never ends is not a tick
      }
    }
    if (buf.length > 1_000_000) buf = ''; // a line that never ends is not a tick
  };
}

/**
 * createYahooSource({ baseUrl, headers, onTick, onState, fetch, log }) -> { setSymbols(tickers), close(), status() }
 * onTick({ symbol: "YAHOO:AAPL", price, session, at }) for every tick; onState() when a shard connects or drops.
 */
export function createYahooSource({ baseUrl, headers = {}, onTick, onState = () => {}, fetch = globalThis.fetch, log, silenceMs = SILENCE_MS, maxPerStream = MAX_PER_STREAM }) {
  let shards = [];
  let closed = false;

  function startShard(tickers) {
    const shard = { tickers, connected: false, ctrl: null, stopped: false, retry: 0, lastData: 0 };
    const url = `${baseUrl}/api/yahoo/stream?symbols=${tickers.map(encodeURIComponent).join(',')}`;
    (async () => {
      while (!shard.stopped && !closed) {
        shard.ctrl = new AbortController();
        let watchdog = null;
        try {
          const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: shard.ctrl.signal });
          if (!res.ok || !res.body) throw new Error(`relay answered ${res.status}`);
          shard.connected = true;
          shard.lastData = Date.now();
          onState();
          watchdog = setInterval(() => { if (Date.now() - shard.lastData > silenceMs) shard.ctrl.abort(new Error('stream silent')); }, Math.min(silenceMs, 10_000));
          watchdog.unref?.();
          const push = sseParser((text) => {
            let t;
            try { t = JSON.parse(text); } catch { return; }
            if (!t || typeof t.s !== 'string' || !Number.isFinite(t.p)) return;
            shard.retry = 0;
            onTick({ symbol: `YAHOO:${t.s}`, price: t.p, session: Number.isInteger(t.m) ? t.m : 1, at: Date.now() });
          });
          const decoder = new TextDecoder();
          for await (const chunk of res.body) {
            shard.lastData = Date.now(); // pings count: the relay is alive
            push(decoder.decode(chunk, { stream: true }));
          }
          throw new Error('stream ended');
        } catch (e) {
          if (shard.stopped || closed) break;
          log?.debug?.('yahoo stream dropped', { error: e?.message, symbols: tickers.length });
        } finally {
          clearInterval(watchdog);
          if (shard.connected) { shard.connected = false; onState(); }
        }
        const wait = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** shard.retry++);
        await new Promise((r) => { const t = setTimeout(r, wait); t.unref?.(); shard.wake = r; });
      }
    })();
    return shard;
  }

  function stopShard(s) { s.stopped = true; s.ctrl?.abort(); s.wake?.(); }

  /** Watches exactly these tickers. A ticker keeps its shard, so unchanged shards keep their connection. */
  function setSymbols(tickers) {
    const groups = assignShards(shards.map((s) => s.tickers), tickers, maxPerStream);
    const byGroup = new Map(shards.map((s) => [s.tickers, s]));
    const next = groups.map((g) => byGroup.get(g) ?? startShard(g));
    const kept = new Set(next);
    for (const s of shards) if (!kept.has(s)) stopShard(s);
    shards = next;
    onState();
  }

  function close() { closed = true; for (const s of shards) stopShard(s); shards = []; }

  function status() {
    return { streams: shards.length, connected: shards.filter((s) => s.connected).length, symbols: shards.reduce((n, s) => n + s.tickers.length, 0) };
  }

  return { setSymbols, close, status };
}
