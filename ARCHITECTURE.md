# Architecture: Wickline Self-Hosted

The self-hosted edition runs the **unmodified** upstream Wickline app headless in one Docker container. The extra pieces wrap it from `selfhost/`:

- authentication;
- SQLite persistence with cross-device sync;
- a background alert worker;
- notifications (Gotify).

The full design, including the current-architecture assessment, ADRs, phased plan, risks and owner decisions, is in [`selfhost/docs/PLAN.md`](selfhost/docs/PLAN.md). The independent design review it was revised against is in [`selfhost/docs/reviews/`](selfhost/docs/reviews/).

## At a glance

```
browser ──► selfhost/server.mjs  public port (5173)
  │           auth · same-origin · /api/selfhost/* · snapshot + boot.js injected into index.html
  │           │ every other request, in-process
  │           ▼
  │         upstream server.mjs (unchanged): app, /api/yahoo/* relay ──► Yahoo
  │           ▲
  │           │ loopback listener 127.0.0.1:<random>, per-process credential, 3 GET routes
  │         alert worker (worker_threads) ──► Binance, Coinbase (through WICKLINE_PROXY)
  │           │ triggers, progress, heartbeats (postMessage)
  │           ▼
  └─ SSE ◄─ sync state + alerts ledger ── SQLite /data/wickline.db ── outbox ──► Gotify
```

## Module map (`selfhost/`)

| Path | Role |
|---|---|
| `server.mjs` | Entry point: config, the data-folder lock, migrations, auth, routes, the internal listener, the alert supervisor, graceful shutdown. |
| `config.mjs` | Environment variables (and `*_FILE` secrets), validated; an invalid configuration exits with code 78. |
| `auth/` | Password (scrypt), TOTP, sessions and API tokens (stored as digests), the login throttle. |
| `http/` | Request helpers, security headers, the login page, `index.html` injection, admin (backup, export, import) and notification routes. |
| `storage/` | `node:sqlite`, numbered migrations with a pre-migration backup, backups, restore, the data-folder lock. |
| `sync/` | Key policies (`key-classes.json`), the generic id-merge, the versioned state with history and tombstones, the SSE hub, the routes. |
| `public/boot.js` | The browser agent: hydrates localStorage from the snapshot, mirrors writes, holds the leader tab's event stream, applies remote changes. |
| `alerts/merge.mjs`, `alerts/ledger.mjs` | The alerts merge (server-owned trigger fields, re-arm rules, tombstones), trigger records, one queued push per trigger, server triggers. |
| `alerts/evaluate.mjs` | Upstream's crossing rules, one price chain per market session, resume points. |
| `alerts/feeds.mjs`, `alerts/sources/` | Streaming sources (Yahoo relay, Binance, Coinbase), stable sharding, market hours, REST fallback, staleness. |
| `alerts/worker.mjs`, `alerts/supervisor.mjs`, `alerts/net.mjs` | The worker thread, its supervisor (restarts, heartbeat watchdog), and its network routes. |
| `notify/` | The Gotify provider and the durable outbox. |
| `paper/` | Server-side paper trading: browser presence (who owns the live account) and the evaluator that runs upstream's engine while no main window is open. |
| `cli.mjs` | `hash-password`, `totp-setup`, `token`, `sessions`, `backup`, `restore`, `notify-test`. |
| `test/` | Unit, contract (against upstream), API, Playwright e2e and the container smoke test. |

## Main flows

**Sync.** Every page load gets the synced keys as an escaped JSON block in `index.html`, so `boot.js` fills localStorage before upstream's code runs. A write is sent with the version it was based on. The server applies the key's policy in one SQLite transaction: compare-and-swap, id-merge or last-write-wins. Every change gets a global revision, broadcast over SSE to the other devices. The leader tab holds the stream, and a restore or import starts a new epoch so browsers re-hydrate.

**Alerts.** The supervisor sends the worker the armed alerts and their resume points. The worker streams prices per symbol and evaluates each one with upstream's rules. When a market is open but its stream goes quiet, it polls REST instead, and it reports stale symbols. A crossing goes back to the main thread. There, `ledger.trigger()` marks the alert fired in the synced value (a new version, pushed to browsers) and queues the Gotify push in the same transaction. A browser that detects the same crossing reports it through the merge, which collapses it into the recorded trigger, so each trigger is pushed once.

## Key decisions (details in PLAN.md §3)

| ADR | Decision |
|---|---|
| 001 | Wrap the upstream server; never modify it. |
| 002 | Sync at the localStorage boundary: `boot.js` hydrates from a server snapshot and mirrors writes. |
| 003 | The snapshot is an escaped JSON block inlined into `index.html`. |
| 004 | Per-key conflict policy: compare-and-swap, id-merge or last-write-wins (`selfhost/sync/key-classes.json`). |
| 005 | Built-in `node:sqlite`. |
| 006 | Native quote adapters in a supervised worker; Yahoo via the upstream relay. |
| 007 | The server is the only push notifier, with dedup by trigger identity. |
| 008 | Durable notification outbox, at-least-once delivery. |
| 009 | Single-user session auth, with TOTP mandatory in public mode. |
| 010 | `main` mirrors upstream; `selfhosted` is production; upstream merged by PR with merge commits. |
| 011–012 | Everything under `selfhost/`; upstream workflows disabled in settings, not edited. |
| 013 | Server-side paper trading: best effort, the server fills only while no main window is open (no upstream hook; see `selfhost/docs/PHASE5-PAPER.md`). |
| 014 | Upstream code runs only in CI jobs without secrets. |

## Deliberate deviations found while building

- **The internal listener.** The worker reads upstream's relay through a second listener bound to 127.0.0.1. It never uses the public port, so a reverse proxy cannot reach it.
- **Market hours.** Upstream's chart output does not include Yahoo's trading periods. A market counts as open while the symbol's 1-minute chart has a bar from the last 15 minutes.
- **Binance futures.** They stream from `/market/stream`. Upstream's `/stream` path still connects but no longer sends prices.
- **Readiness.** `/api/health/ready` reports the web server and database only. The alert worker restarts on its own and is reported at `/api/selfhost/alerts/status`.

## Upstream integration points

The upstream behaviours this edition depends on are listed in [`selfhost/INTEGRATION_POINTS.json`](selfhost/INTEGRATION_POINTS.json). Each is pinned by a contract test in `selfhost/test/contract/`. Modified upstream files: **none** (see `selfhost/UPSTREAM_PATCHES.json`).

## Differences from upstream

| Area | Upstream | Self-hosted |
|---|---|---|
| Runtime | Desktop (Electron), static site or `node server.mjs` | Docker container (no Electron), always on |
| User data | Browser localStorage per device | SQLite, synced across devices |
| Alerts | Evaluated only while a browser tab is open | Evaluated server-side 24/7; Gotify push |
| Access | Local only (127.0.0.1) | LAN or Tailscale; optional public mode (HTTPS, TOTP) |
| Auth | None | Single-user password, session cookie, optional TOTP |

## Known limitations

- **Single user.**
- **No desktop app:** the image runs upstream's web app; the Electron desktop wrapper is not part of it.
- **Content security policy:** report-only, because upstream relies on an inline script and `unsafe-eval` in its script sandbox.
- **Alerts:**
  - The Yahoo fallback gets the regular-session price, so during a stream outage in pre-market or after-hours, extended-hours checks pause.
  - A very thinly traded stock can count as closed until it trades.
- **One container per data folder.** After an unclean stop, a replacement container may be refused for up to 90 seconds.
- **Server-side paper trading is best effort**: the server fills only while no main window is open, with the edge cases listed in SELFHOSTED.md.
