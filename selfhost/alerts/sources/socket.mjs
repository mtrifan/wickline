// A WebSocket that stays open: rotates through hosts, reconnects with exponential backoff, and
// reopens a connection that has been silent for `silenceMs` (no message at all). Used by the
// crypto sources (PLAN §2.5.2).

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * keepOpen({ urls, openWs, onOpen(ws), onMessage(data), onState(), silenceMs, log, name })
 *   urls      () => [url, ...] tried in turn (a function, so the subscription can change)
 *   openWs    (url) => a WebSocket (injected: the worker's routes it through WICKLINE_PROXY)
 *   ping      { everyMs, message: () => string }: an application-level ping some exchanges need
 *             (Bybit, OKX); its replies also keep the silence watchdog quiet
 *   priceSilenceMs  reopen a connection that has delivered no price for this long, even if pongs
 *             keep arriving (a stalled subscription). onMessage returns true for a price.
 * Returns { close(), get connected() }.
 */
export function keepOpen({ urls, openWs, onOpen = () => {}, onMessage, onState = () => {}, silenceMs = 180_000, priceSilenceMs = null, ping = null, log, name = 'stream' }) {
  let ws = null;
  let host = 0;
  let retry = 0;
  let closed = false;
  let connected = false;
  let timer = null;
  let watchdog = null;
  let pinger = null;
  let lastMessage = 0;
  let lastPrice = 0;
  let openedAt = 0;

  const setConnected = (v) => { if (connected !== v) { connected = v; onState(); } };

  function connect() {
    if (closed) return;
    const list = urls();
    if (!list.length) return;
    const url = list[host % list.length];
    let sock;
    try { sock = openWs(url); } catch (e) { log?.debug?.(`${name} could not open`, { error: e?.message }); return scheduleReconnect(); }
    ws = sock;
    openedAt = Date.now();
    sock.onopen = () => {
      if (ws !== sock) return;
      lastMessage = lastPrice = Date.now(); // the price clock starts at the subscription
      setConnected(true);
      try { onOpen(sock); } catch (e) { log?.error?.(`${name} subscribe failed`, { error: e?.message }); }
      if (ping) {
        clearInterval(pinger);
        pinger = setInterval(() => { try { sock.send(ping.message()); } catch { /* closing */ } }, ping.everyMs);
        pinger.unref?.();
      }
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastMessage = Date.now();
      retry = 0; // only data proves the connection works: a socket that opens and drops keeps backing off
      try {
        if (onMessage(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) === true) lastPrice = Date.now();
      } catch (e) { log?.debug?.(`${name} message dropped`, { error: e?.message }); }
    };
    sock.onerror = () => {}; // a close event follows
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(pinger);
      setConnected(false);
      host++; // the next attempt tries the next host
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(timer);
    const wait = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** retry++);
    timer = setTimeout(connect, wait);
    timer.unref?.();
  }

  watchdog = setInterval(() => {
    const now = Date.now();
    const stuck = ws && !connected && now - openedAt > 30_000; // a handshake that never completes
    const stalled = ws && connected && priceSilenceMs != null && now - lastPrice > priceSilenceMs;
    if (stuck || stalled || (ws && connected && now - lastMessage > silenceMs)) {
      log?.debug?.(`${name} silent; reconnecting`);
      try { ws.close(); } catch { /* closing anyway */ }
    }
  }, Math.min(silenceMs, 10_000));
  watchdog.unref?.();

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      clearInterval(pinger);
      const s = ws;
      ws = null;
      setConnected(false);
      try { s?.close(); } catch { /* gone */ }
    },
    get connected() { return connected; },
  };
}
