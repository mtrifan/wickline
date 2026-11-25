// Server-sent events for synced state (PLAN §2.3.4): one stream per browser profile.
//
//   GET /api/selfhost/events?epoch=<epoch>&since=<rev>
//
// Each change is an `event: change` whose `id` is its rev, so a reconnecting EventSource resumes
// with Last-Event-ID (which takes precedence over `since`) and receives everything it missed,
// deletions included. A stream from another epoch, or one claiming a rev this server has not
// reached (the database was restored), gets `event: reset` and is closed: the client must fetch a
// fresh snapshot rather than resume.

const HEARTBEAT_MS = 25_000;
/** A client this far behind on reading is dropped; it resumes from Last-Event-ID on reconnect. */
const MAX_BUFFERED = 8 * 1024 * 1024;

const frame = (event, data, id) => `${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createEventHub(state, { maxClients = 32, heartbeatMs = HEARTBEAT_MS } = {}) {
  /** res → { session } */
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

  const heartbeat = setInterval(() => { for (const res of [...clients.keys()]) send(res, ': ping\n\n'); }, heartbeatMs);
  heartbeat.unref();

  /** Serves one stream. `session` identifies the login, so logging out can close its streams. */
  function handle(req, res, url, { session = null } = {}) {
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
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('since') ?? '';
    const since = /^\d{1,15}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(since) || since > state.rev()) return reset();

    // Replay and subscribe in the same tick: writes are synchronous, so none can fall in between.
    for (const c of state.changesSince(since)) res.write(frame('change', c, c.rev));
    clients.set(res, { session });
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
    for (const res of [...clients.keys()]) drop(res);
  }

  return { handle, resetAll, dropSession, close, get size() { return clients.size; } };
}
