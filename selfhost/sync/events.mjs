// Server-sent events for synced state (PLAN §2.3.4): one stream per browser profile.
//
//   GET /api/selfhost/events?epoch=<epoch>&since=<rev>
//
// Each change is an `event: change` whose `id` is its rev, so a reconnecting EventSource resumes
// with Last-Event-ID (which takes precedence over `since`) and receives everything it missed,
// deletions included. Without either, the stream replays all current state.
//
// A client must close its EventSource on `reset`: EventSource reconnects to the same URL by
// itself, which would only be reset again. A stream from another epoch, or one claiming a rev this server has not
// reached (the database was restored), gets `event: reset` and is closed: the client must fetch a
// fresh snapshot rather than resume. So does a backlog larger than the buffer cap: the snapshot
// is a plain response, while a stream that cannot drain would be dropped and reconnect forever.
//
// Every heartbeat re-checks each stream's credentials, so an expired session or a revoked token
// does not keep receiving changes over a connection opened while it was valid.

const HEARTBEAT_MS = 25_000;
/** A client this far behind on reading is dropped; it resumes from Last-Event-ID on reconnect. */
const MAX_BUFFERED = 8 * 1024 * 1024;

const frame = (event, data, id) => `${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createEventHub(state, { maxClients = 32, heartbeatMs = HEARTBEAT_MS } = {}) {
  /** res → { session, isValid } */
  const clients = new Map();

  const drop = (res) => { clients.delete(res); try { res.end(); } catch { /* gone */ } };
  const send = (res, chunk) => {
    try {
      res.write(chunk);
      if (res.writableLength > MAX_BUFFERED) drop(res);
    } catch { drop(res); }
  };

  // state.write() refuses keys that do not sync, so every change it reports is broadcast.
  const unsubscribe = state.onChange((c) => {
    const chunk = frame('change', c, c.rev);
    for (const res of [...clients.keys()]) send(res, chunk);
  });
  // A new epoch (restore, import) invalidates every open stream.
  const unsubscribeEpoch = state.onEpoch(() => resetAll());

  function revalidate() {
    for (const [res, c] of [...clients]) {
      let ok = false;
      try { ok = c.isValid(); } catch { /* treat as invalid */ }
      if (!ok) drop(res);
    }
  }

  const heartbeat = setInterval(() => {
    revalidate();
    for (const res of [...clients.keys()]) send(res, ': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  /**
   * Serves one stream. `session` identifies the login, so logging out can close its streams;
   * `isValid()` is re-checked on every heartbeat.
   */
  function handle(req, res, url, { session = null, isValid = () => true } = {}) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' });
      return res.end(JSON.stringify({ error: 'Too many event streams' }));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // nginx and similar proxies: do not buffer the stream
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    const reset = () => { res.end(frame('reset', { epoch: state.epoch(), rev: state.rev() })); };
    const epoch = url.searchParams.get('epoch');
    if (epoch !== state.epoch()) return reset();
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('since') ?? '0';
    const since = /^\d{1,15}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(since) || since > state.rev()) return reset();

    // Replay and subscribe in the same tick: writes are synchronous, so none can fall in between.
    const backlog = [];
    let bytes = 0;
    for (const c of state.changesSince(since)) {
      const f = frame('change', c, c.rev);
      bytes += Buffer.byteLength(f);
      if (bytes > MAX_BUFFERED) return reset();
      backlog.push(f);
    }
    for (const f of backlog) res.write(f);
    clients.set(res, { session, isValid });
    const gone = () => clients.delete(res);
    res.on('close', gone);
    req.on('close', gone);
  }

  /** Tells every stream to re-hydrate (after a restore or import) and closes it. */
  function resetAll() {
    const chunk = frame('reset', { epoch: state.epoch(), rev: state.rev() });
    for (const res of [...clients.keys()]) { send(res, chunk); drop(res); }
  }

  /** Closes the streams opened with a session (logout). */
  function dropSession(session) {
    for (const [res, c] of [...clients]) if (c.session === session) drop(res);
  }

  function close() {
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeEpoch();
    for (const res of [...clients.keys()]) drop(res);
  }

  return { handle, resetAll, dropSession, revalidate, close, get size() { return clients.size; } };
}
