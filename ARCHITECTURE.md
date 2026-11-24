# Architecture: Wickline Self-Hosted

The self-hosted edition runs the **unmodified** upstream Wickline app headless in one Docker container. The extra pieces wrap it from `selfhost/`:

- authentication;
- SQLite persistence with cross-device sync;
- a background alert worker;
- notifications (Gotify).

The full design, including the current-architecture assessment, ADRs, phased plan, risks and owner decisions, is in [`selfhost/docs/PLAN.md`](selfhost/docs/PLAN.md). The independent design review it was revised against is in [`selfhost/docs/reviews/`](selfhost/docs/reviews/).

## At a glance

```
browser ──► selfhost/server.mjs (auth · /api/selfhost/* · HTML snapshot injection)
                 │ delegates every other request, in-process
                 ▼
            upstream server.mjs (unchanged)  ◄── alert worker (worker_threads) via loopback
                 │
            SQLite /data/wickline.db  ·  notifications outbox → Gotify
```

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
| 013 | Server-side paper trading deferred; needs an upstream hook. |
| 014 | Upstream code runs only in CI jobs without secrets. |

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

These are tracked in PLAN.md §8 and will be completed as each phase ships.
