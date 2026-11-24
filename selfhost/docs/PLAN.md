# Wickline Self-Hosted Edition: Architecture Assessment & Implementation Plan

| | |
|---|---|
| **Status** | **APPROVED v2.1** (2026-11-24); owner decisions in §9. Revised after an independent Fable 5.2 design review (25 findings: 2 critical, 7 high, all checked against the source). See §11 for what changed and why. |
| **Baseline** | upstream `keptaduona/wickline` v0.1.9 (`e6c1c53`) |
| **Target** | public fork `github.com/mtrifan/wickline` (personal project; no employer affiliation) |

---

## 0. Executive summary

Wickline suits a self-hosted edition well. It already ships an optional headless Node server (`server.mjs`, Node ≥ 22, no build step, one runtime dependency: `undici`). The desktop app is just Electron loading that same server on `http://127.0.0.1:41573`.

The plan is **additive**:

- Everything self-hosted lives under a new `selfhost/` directory. It wraps the upstream server instead of modifying it.
- **Phases 0–4 modify zero upstream files.** CI enforces this.
- One small hook, which we would offer upstream, is needed only for the optional server-side paper-trading phase.

The core mechanism is a **localStorage-boundary sync agent**:

1. The self-hosted server injects a JSON snapshot of the user's state (from SQLite) plus a small bootstrap into `index.html` at request time.
2. The bootstrap hydrates `localStorage` before any upstream code runs.
3. It then mirrors changes to `wickline.*` keys to the server and applies remote changes pushed over SSE.

All ~48 synchronous storage call sites keep working unchanged. That includes the three modules that bypass `store`. Conflicts are handled per key: compare-and-swap for large blobs, id-based merges for scripts and alerts, and last-write-wins only for small preferences. A stale device therefore never silently overwrites newer data.

Alerts move to a **supervised server-side worker** (`worker_threads`):

- **Yahoo data:** consumes the upstream server's own Yahoo relay stream over an internal loopback listener. This reuses its caching, crumb handling, failover and proxy support, and keeps the market-session flag.
- **Crypto data:** talks to Binance and Coinbase directly through small, hardened adapters.
- **State and notifications:** alert state lives in SQLite. Gotify notifications go through a durable, deduplicated outbox.

---

## 1. Current architecture assessment (v0.1.9)

### 1.1 Shape

**Frontend**
- **Files:** `public/index.html`, plus 36 vanilla ES modules in `public/js/` (plus `lang/`). `lightweight-charts` is vendored.
- **Build and loading:** no bundler, import map or service worker. The entry point is `<script type="module" src="js/app.js">` (index.html:421).
- **Inline head script:** index.html:12-19 reads `wickline.theme` and `wickline.paint` for first paint.

**Optional server**
- **Files:** `server.mjs` (1092 lines), `lib/*.mjs`.
- **Exports:** `startServer({port,host})` resolves `{server, port}` (server.mjs:1074). `handleRequest` and `routeRequest` are private.
- **Request handling:**
  - Every non-GET request gets a 405 before routing (:1063).
  - Upstream reads only `req.url`, `req.headers.host`, `req.method` and `req.on('close')`, never `req.socket`.
- **Yahoo relay:** a TTL cache (:53-57), an SSE stream `/api/yahoo/stream` (:921) that truncates to **100 symbols** (:922), and an upstream `YahooStreamer` WebSocket (:840).
- **Headers:** CORS `*` is always set through `writeHead(status, headers)` (11 calls, no `setHeader`).
- **Missing:** SIGTERM handling, persistence and auth.

**Desktop**
- **Files:** `desktop/main.mjs`, `preload.cjs`, `proxy.mjs`.
- **Startup:** imports `startServer` in-process and loads `127.0.0.1:41573`. If that port is busy it tries 41574–41592, then a random port.
- **Persistence:** Chromium localStorage in `userData`, plus `window-state.json` and `proxy.json`.

**Static mode**
- `env.js` `dataMode()` probes `api/health` once and remembers the result for the module's lifetime.
- If there is no server, it falls back to Twelve Data (user key) plus the direct Yahoo WebSocket.

**Outbound proxy**
- `lib/proxy.mjs` `setGlobalDispatcher` routes all Node `fetch` and `WebSocket` traffic, so workers inherit it.

### 1.2 Browser persistence inventory

**How state is stored**
- Everything is in `localStorage` under `wickline.*`, using only `getItem`, `setItem` and `removeItem`. There is no IndexedDB, sessionStorage, cookies or service worker.
- `store` (util.js:3-15) does synchronous JSON reads and writes and swallows errors.
- Three modules bypass it: `drawings.js:60,63`, `scripts.js:193,197`, and `i18n.js:51,74,80,81` (`removeItem` means "follow the system language").
- **Storage-event listeners:** `alerts.js:27`, `trading.js:108`, `scripts.js:223`, `i18n.js:124` (reloads the page). Each checks only `e.key`.

**Sync classification**

| Class | Keys |
|---|---|
| **Sync, id-merge** | `scripts`, `alerts` |
| **Sync, compare-and-swap** | `workspace`, `watchlist`, `paper`, `drawings.<symbol>` |
| **Sync, last-write-wins (small preferences)** | `watchlistCollapsed`, `theme`, `appearance`, `lang` (with deletion), `tfFavorites`, `extHours`, `screener`, `news`, `heatmap`, `paperQty`, `layoutSizes` |
| **Device-local** | panel heights (`*Height`), `paint` (derived first-paint cache), `sideTab`, `toolGroups`, `marketGroup`, `communitySort`, `editorScript`, `paperTicket`, `apiBase`, `tdKey` (secret), `tdRate`, `updateCheck`, `updateDismissed`, and legacy `state` (read-only fallback, app.js:133) |

**Behaviours the sync design must respect**
- **Synchronous startup:** about 40 `store.get` calls plus about 8 direct reads run synchronously at module load (for example `i18n.js:58`, `app.js:131`). State must be in `localStorage` before `app.js` evaluates.
- **Writes during boot:** `applyLayout` → `saveWorkspace` writes `workspace` 150 ms after every page load (app.js:144-148, 229), and `theme.js:153` writes `paint`.
- **Whole-blob saves:** `trading.js:115` saves the entire paper account on `beforeunload`.
- **URL hash wins:** `#s=…&tf=…` is applied over the stored active chart on every load (app.js:139).
- **No import or export** of user data exists anywhere.

### 1.3 Market data providers

| Provider | Transport | Where | Notes |
|---|---|---|---|
| Binance spot / USDⓈ-M | REST + WebSocket `@miniTicker` | browser | REST 429/418 backoff (datafeed.js:86-110). WebSocket retry is a flat 3 s, alternating hosts (:846-857). |
| Coinbase | REST + WebSocket ticker | browser | Same retry pattern (:867-879). |
| Yahoo | server relay `/api/yahoo/*` + SSE (ticks carry the session flag `m`: 0 pre, 1 regular, 2 post, server.mjs:835) | server | TTL cache, stale-on-error, host failover, crumb |
| Twelve Data | REST, user key | browser (static only) | sliding-window limiter |
| Deribit | REST (options) | server | — |

- **Symbol ids:** `SOURCE:TICKER`, with YAHOO as the default.
- **`QuoteStream`** (datafeed.js:792-927) drops `m` and passes only `{price, change, precision}` (:892). It alternates Yahoo stream prices with a 60-second regular-session poll (:895-904).
- **Market hours:** there is no exchange calendar. Yahoo chart `meta.currentTradingPeriod` / `tradingPeriods` (server.mjs:97-122) and tick recency are the usable signals. `/api/yahoo/quotes` does **not** return `marketState`.

### 1.4 Alerts (`public/js/alerts.js`)

- **Model:** `{id, symbol, condition: 'cross'|'up'|'down', price, message, active, created, triggeredAt?, triggerPrice?}`. Alerts are price-level, fire once, and are re-armed manually.
- **Evaluation:**
  - Happens only in the main browser window, against a dedicated `QuoteStream`.
  - The crossing rule is `prev < level ≤ price` (or the mirror for downward crosses).
  - The first tick after start is ignored, so a crossing while the app was closed is never seen.
- **Writes:** every change writes the whole array (:56-58).
- **Notifications:** chime, toast and the browser Notification API.

### 1.5 Paper trading (`paper.js`, `trading.js`)

- **`PaperAccount`:**
  - Pure and deterministic. Its only import is i18n, and it is unit-tested in Node.
  - Order types: market, limit and stop, with stop-loss and take-profit.
  - Ids are per-account sequences.
- **`trading.js`:**
  - DOM-bound.
  - The main window evaluates fills from its own `QuoteStream` and from chart updates.
  - It saves the whole account 300 ms after each change and on `beforeunload`.

### 1.6 Tests and CI

- **Unit tests:** 20 files in `test/*.test.mjs` (`node:assert` plus a mini runner), chained in `package.json:18`. That line changes every upstream release.
- **Server test:** `test/server.test.mjs` uses `startServer({port:0})` and needs no network.
- **End-to-end:** `test/e2e.mjs` is Electron-based, needs live internet and is not run in CI. **No Playwright.**
- **Workflows:**
  - `release.yml`: runs on `v*` tags.
  - `pages.yml`: manual.
  - `community.yml`: issue-driven, plus a daily cron that commits to the branch it runs on.
  - There is no PR test workflow.

### 1.7 Licensing and upstream compatibility

**Licences**
- Upstream is **MIT**: forking and redistributing Docker images are allowed if `LICENSE` is retained.
- `lightweight-charts` is Apache-2.0 and already ships its own LICENSE file.
- `undici` is MIT.
- The image ships `LICENSE` and `public/vendor/LICENSE-lightweight-charts.txt`.

**Naming:** "Wickline Self-Hosted (unofficial)", with a clear non-affiliation note.

**Hardcoded upstream references stay as they are deliberately:**
- the desktop-only update check (`update.js:5`);
- the community library (`community.js:15-16`, `lib/community.mjs:11`).

**Upstream velocity:** 10 tags in about 7 days, each a large squashed commit. Editing upstream files would conflict constantly, which validates the zero-edit approach.

---

## 2. Proposed architecture

```
                 LAN / Tailscale (Serve)
                       │
              ┌────────▼──────────────────────────────────────────────┐
  container   │ selfhost/server.mjs   public listener 0.0.0.0:5173    │
  node:24-    │  ├─ headers · writeHead wrapper (strips CORS *)       │
  slim        │  ├─ auth (session cookie / bearer)                    │
  uid 99:100  │  ├─ /api/selfhost/*  state · events(SSE) · alerts ·   │
              │  │                    notify/test · backup · import    │
              │  ├─ GET / → index.html + JSON snapshot + boot.js      │
              │  └─ else → upstreamHandler (captured, in-process) ────┼─┐
              │ upstream server.mjs (unchanged)  ◄────────────────────┼─┘
              │   + internal listener 127.0.0.1:<random>  ◄──┐        │
              │ ┌ worker_threads: alert worker (supervised) ─┘ Yahoo  │
              │ │  adapters: loopback Yahoo SSE (with m) · Binance WS │
              │ │            · Coinbase WS · REST fallback            │
              │ │  evaluator → alert_state → outbox (via main thread) │
              │ └──────────────────────────────────────────────────── │
              │ notifier: outbox → Gotify (retry/backoff)              │
              │ backups: VACUUM INTO /data/backups                     │
              │ SQLite (node:sqlite, WAL) /data/wickline.db            │
              └───────────────────────────────────────────────────────┘
```

### 2.1 Directory layout (all new; nothing upstream moved)

```
selfhost/
  server.mjs  config.mjs  cli.mjs
  http/        router, auth, csrf, headers (writeHead wrapper), body, html-inject
  storage/     db.mjs (node:sqlite wrapper), state-repo.mjs, migrations/NNN_*.sql, backup.mjs
  sync/        key-policy.mjs (allow-list + policy per key), merge/{alerts,scripts}.mjs, sse-hub.mjs
  alerts/      worker.mjs (worker_threads entry), supervisor.mjs, evaluator.mjs (pure),
               adapters/{yahoo-relay,binance,coinbase,rest-fallback}.mjs, market-hours.mjs
  notify/      provider.mjs, gotify.mjs, outbox.mjs
  public/      boot.js, login.html, settings.html, export-snippet.js
  INTEGRATION_POINTS.json
  Dockerfile  Dockerfile.dockerignore  docker-compose.yml  unraid/wickline.xml
  package.json          # selfhost-only devDeps (Playwright); root package.json untouched
  docs/adr/  test/{unit,contract,api,e2e,docker,fixtures}
.github/workflows/selfhost-*.yml
UPSTREAM.md SELFHOSTED.md ARCHITECTURE.md CHANGELOG-SELFHOSTED.md UPGRADE.md
```

### 2.2 Request pipeline

> **Phase 1 implementation note:** upstream's request handler is captured from `startServer()`, and upstream's own listener is **closed immediately**. No unauthenticated port stays open, not even on loopback. When the Phase 3 alert worker needs the Yahoo relay, it will be served the same captured handler on a private Unix socket (in a mode-0700 directory), not a TCP port.

**Startup:**
1. `selfhost/server.mjs` repeats upstream's script-mode proxy init (server.mjs:1083-1089).
2. It calls upstream `startServer({port:0, host:'127.0.0.1'})`. This internal listener is used only by the alert worker's Yahoo adapter.
3. It captures `server.listeners('request')[0]` as `upstreamHandler`.
4. It creates its own public `http.Server`.

**Each public request passes through, in order:**
1. a `writeHead` wrapper, which deletes `Access-Control-Allow-Origin` in both `(status, headers)` and `(status, msg, headers)` forms, for object and array headers;
2. security headers;
3. auth;
4. selfhost routes (any HTTP method);
5. HTML injection for `/` and `/index.html`;
6. `upstreamHandler`.

**Safeguards:**
- A contract test pins the "one request listener" shape.
- The documented fallback needs no upstream PR: pipe to the internal listener with `http.request`.
- The internal listener carries no user data, only the public Yahoo relay. With Unraid **host** networking it would be reachable by local host processes. That is low risk, documented, and bridge networking is recommended.

### 2.3 Sync agent (`selfhost/public/boot.js`)

#### 2.3.1 Injection

`GET /` and `GET /index.html` are served `Cache-Control: no-store`. Immediately after `<head>`, the server inserts:

- `<script type="application/json" id="wl-snapshot">…</script>`. The JSON is escaped so that `<`, `>`, `&`, U+2028 and U+2029 become `\uXXXX`, which makes stored script source inert. A unit test covers `</script><script>` and `<!--` payloads.
- `<script src="/selfhost/boot.js"></script>`, a classic synchronous script.

The snapshot contains:
- `epoch`, a restore/import generation;
- `rev`;
- per key: `{v, ver, deleted}`;
- `profileHint`.

If the `<head>` anchor is missing, the page is served with a visible error banner and a contract test fails.

#### 2.3.2 Hydration

1. boot.js parses the snapshot with `JSON.parse`.
2. **Epoch mismatch:** after a restore or import, the snapshot's `epoch` differs from `wickline-selfhost.epoch`. boot.js discards local version metadata and the dirty set, then hydrates fully.
3. **First run on this profile:** if there is no `wickline-selfhost.epoch` marker and local `wickline.*` data exists, boot.js goes to Migration (§2.3.7) **before** capturing any writes.
4. **Otherwise:** for each key whose server `ver` is greater than the local `wickline-selfhost.v.<key>`:
   - write the value, or `removeItem` if it is a tombstone;
   - unless that key is dirty locally. A dirty key is uploaded first and resolved by policy.

Versions are stored one key each (`wickline-selfhost.v.<key>`), never as one shared JSON blob, so tabs cannot lose each other's updates.

#### 2.3.3 Write capture

- boot.js patches `Storage.prototype.setItem` and `removeItem`, only for `window.localStorage` and allow-listed `wickline.*` keys. Original semantics are kept: synchronous, errors swallowed.
- **No-op suppression:** a write whose string equals the stored string is ignored. This matters because upstream rewrites `workspace` and `paint` on every boot.
- The **dirty set** (`wickline-selfhost.dirty.<key>` → base version) holds no values. The value is read from localStorage at send time, so data is never duplicated and the storage quota is respected.
- Writes are debounced per key (400 ms), then sent as `PUT /api/selfhost/state/:key {value, baseVersion}`.
- `pagehide` and `visibilitychange` flush the queue with `fetch(keepalive)`.

#### 2.3.4 One connection per browser profile

- A **leader** tab, elected through the Web Locks API with a BroadcastChannel fallback, owns the single `EventSource('/api/selfhost/events')` and the uploads.
- Follower tabs and pop-outs:
  - send their dirty keys to the leader over BroadcastChannel;
  - receive remote changes through native `storage` events when the leader writes to localStorage.
- This keeps each profile at one extra long-lived connection, which matters under HTTP/1.1's six-connections-per-origin limit, since upstream already opens one Yahoo SSE per window.
- `clientId` is **per profile**. The leader ignores its own echoes, and same-profile changes never raise the "another device" banner.

#### 2.3.5 Remote apply

The leader:
1. writes through the unpatched setter (no echo back to the server);
2. dispatches one synthetic `StorageEvent` in its own window. Other tabs get the native event.

Upstream listeners for `alerts`, `paper`, `scripts` and `lang` react live without any upstream change.

For keys with no upstream listener (`watchlist`, `drawings.*`, `theme`, opt-in `workspace`):
- boot.js shows a non-modal banner, "Updated on another device · Reload".
- If the tab is hidden, the change is applied **on the next `visibilitychange → visible`**. It never auto-reloads while hidden, which would discard editor text and reset alert state.
- Before any reload, boot.js strips `s`/`tf` from `location.hash`. Otherwise upstream (app.js:139) would re-apply the old symbol over the synced workspace.

#### 2.3.6 `workspace`

**Synced by default** (owner decision D2), with CAS + no-op suppression + hash strip + apply-on-visible.
`SYNC_WORKSPACE=false` makes it device-local for anyone who prefers per-device layouts.

#### 2.3.7 Migration from existing browser data
The owner is starting fresh (D1), so cross-origin migration (export snippet, Electron LevelDB importer) is **out of scope**.
- **Kept:** a minimal same-origin guard. If a profile already has local `wickline.*` data and no epoch marker, boot.js holds write capture, offers a JSON download of that data, then lets the server's data win.
- **Kept:** JSON export/import via `/api/selfhost/export|import`, as a backup and portability tool.

### 2.4 Storage (SQLite)

#### Driver
- Built-in `node:sqlite` (`DatabaseSync`) on Node 24, with `--disable-warning=ExperimentalWarning`.
- Settings: WAL, `busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`.
- Isolated behind `storage/db.mjs`, so it can be swapped for better-sqlite3.

#### Schema v1
- `kv_state(key PK, value TEXT NULL, deleted INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, rev INTEGER NOT NULL, updated_at, updated_by)`.
  - `rev` comes from a global sequence (`meta.state_rev`) and drives SSE `Last-Event-ID` resume, which also replays tombstones.
- `kv_history(key, version, value, created_at)` keeps the last N (20) versions of id-merge keys, so three-way merges can find the client's base.
- `alert_meta(alert_id PK, last_trigger_key TEXT, last_price REAL, last_tick_at INTEGER, last_session INTEGER, status TEXT, tombstoned_at INTEGER)`.
- `notification_outbox(id PK, dedup_key TEXT UNIQUE, provider, payload, attempts, next_attempt_at, status, last_error, created_at, sent_at)`.
- `sessions(id PK, created_at, last_seen_at, expires_at, user_agent)`, `api_tokens(id, hash, label, created_at, last_used_at)`.
- `meta(key PK, value)`: `schema_version`, `epoch`, `state_rev`, `install_id`, `last_upstream_sync_ok`.

#### Write policies (`sync/key-policy.mjs`)

| Policy | Keys | Behaviour |
|---|---|---|
| `cas` | `watchlist`, `paper`, `drawings.*`, `workspace` | The update applies only if `baseVersion == version`. Otherwise it returns **409** with the current value. The client re-hydrates that key and shows "Your change on this device was replaced by a newer one from another device". A stale `beforeunload` write is rejected **server-side**, so it can no longer roll back a paper account even though the client is gone. Byte-identical values never bump the version. |
| `merge:scripts` | `scripts` | Three-way merge by `id` against the client's base from `kv_history`: adds, deletes (tombstoned id) and edits (newer `updated` wins per script). |
| `merge:alerts` | `alerts` | See §2.5.6. |
| `lww` | small preferences | Accept and bump the version. Deletions are stored as tombstones. |

#### Concurrency
- A single process (the worker posts mutations to the main thread), synchronous SQLite, and every write wrapped in a transaction.
- Version and rev are assigned inside that transaction.

#### Migrations
- Numbered SQL files tracked by `PRAGMA user_version`, each run in a transaction.
- An **automatic pre-migration backup** is taken (`/data/backups/pre-migrate-<from>-<to>-<ts>.db`).
- The server **refuses to start** if the DB is newer than the code (a downgrade), and prints rollback steps.

#### Backup and restore
- A scheduled `VACUUM INTO` runs daily by default, keeping 14 copies.
- `GET /api/selfhost/backup` downloads the `.db`.
- `GET /api/selfhost/export` and `POST /api/selfhost/import` use portable JSON.
- `cli.mjs restore <file>` runs with the container stopped. It checks integrity and schema version, then **bumps `epoch`** so browsers holding newer local state re-hydrate instead of undoing the restore.

### 2.5 Background alerts

#### 2.5.1 Isolation
- The worker runs in a `worker_threads` Worker under a supervisor that restarts it with backoff and exposes a heartbeat to `/api/health/ready`.
- All adapter message handlers are wrapped in try/catch.
- The main process also has explicit `uncaughtException` / `unhandledRejection` policies: log, mark unhealthy, and let Docker restart it if needed.
- One malformed exchange frame can never take down the UI or sync.

#### 2.5.2 Quote adapters (native, minimal, hardened)
This replaces ADR-006 v1, which imported upstream `QuoteStream` under a shim (§11).

**Yahoo:**
- Consumes the loopback upstream relay `GET /api/yahoo/stream?symbols=…` through undici's `EventSource` (or a small `fetch`-stream SSE parser).
- This reuses all of upstream's Yahoo server logic and **keeps `m`**.
- Symbols are sharded into groups of ≤ 100 per stream, because of upstream truncation at server.mjs:922.

**Binance spot and futures:** `@miniTicker` WebSocket with host rotation, exponential reconnect and backoff.

**Coinbase:** ticker channel with the same reconnect behaviour.

**REST fallback (only when a symbol is stale):**
- loopback `/api/yahoo/quotes`, which goes through upstream's cache;
- Binance / Coinbase ticker REST, respecting 429/418/Retry-After.

**Reuse boundary:** for Yahoo (the only provider that needs a session, crumb and caching) we reuse upstream server code in full. For crypto we copy about 60 lines of public-endpoint logic rather than shim a 927-line browser module. A contract test pins the endpoints and message shapes we share with upstream `datafeed.js`.

#### 2.5.3 Evaluator
- `evaluate(alert, prev, price) → boolean` is a pure function with upstream semantics: `cross`/`up`/`down`, first tick ignored.
- A contract test drives the real upstream `AlertManager.check` under a minimal DOM stub, using the same tick fixtures, so the two cannot drift apart.

#### 2.5.4 Price chain hygiene
- Every price carries `{source: 'tick'|'poll', session}`.
- A symbol's `prev` chain never mixes extended-hours ticks with polled regular-session prices. This avoids the spurious crosses the browser can produce.
- `ALERT_EXTENDED_HOURS` (default `true`, owner decision D3) sets whether pre- and post-market ticks (`m ∈ {0,2}`) are evaluated. Each session keeps its own `prev` chain, so a jump between the regular close and a pre/post-market price never counts as a crossing.

#### 2.5.5 Market hours, polling and staleness

**Open or closed (Yahoo):**
- Taken from `/api/yahoo/chart` `meta.currentTradingPeriod`, fetched through the loopback and cached per symbol until the period ends.
- Tick recency is a secondary signal.
- Crypto is always open.

**Polling:**
- Streaming is the primary source.
- `ALERT_POLL_INTERVAL` (default 30 s, minimum 10 s) is the REST fallback cadence for stale symbols.
- `ALERT_CLOSED_POLL_INTERVAL` (default 15 min) applies to closed markets. Silence while closed is not staleness.

**Staleness:**
- A symbol is stale when the market is open and there has been no tick for `ALERT_STALE_AFTER` (default 5 min for crypto, 10 min for equities).
- A stale symbol:
  - switches to the REST fallback;
  - is reported in `/api/selfhost/alerts/status`;
  - optionally sends one notification per episode (`NOTIFY_STALE`).
- **An alert never fires from stale or unavailable data.**

**Limits:** `ALERT_MAX_SYMBOLS` (default 200). Truncation is reported, never silent.

**Restart:** `last_price`, `last_tick_at` and `last_session` are persisted (throttled to 5 s and flushed on shutdown).
- If the gap is shorter than `ALERT_RESUME_MAX_GAP` (default 15 min) and the session is the same, the stored values become `prev`, so a crossing during downtime fires once with a "(gap)" note.
- Otherwise the first tick is ignored, matching upstream.

#### 2.5.6 Dual evaluation, the alerts merge, and exactly-one push

The browser's main window still evaluates alerts and shows in-page toasts, because upstream cannot be disabled without an edit. The **server is the only push notifier**.

**Trigger identity:**
- `triggerKey = alert.id + ':' + triggeredAt`, where `triggeredAt` is set by whichever side detected the crossing.
- Outbox dedup key: `alert:<triggerKey>`.

**Exactly-one push across both sides:**
- **Server trigger:** writes `active=false, triggeredAt, triggerPrice` into the `alerts` value (version bump + SSE) and enqueues `alert:<id>:<t>`.
- **Client trigger** (arriving via merge, with a new `triggeredAt` the server has not recorded):
  - enqueue `alert:<id>:<t>` with source=client;
  - set `last_trigger_key`.
- **Both sides trigger the same crossing** (different `triggeredAt` within `ALERT_DUAL_WINDOW` = 120 s for the same alert):
  - the second one is collapsed: no second enqueue;
  - the earlier `triggeredAt` is kept.
- **Re-arm then re-trigger while the server is down:** the new `triggeredAt` differs from the recorded one, so it is a new trigger and is pushed once. This fixes the v1 lost-push case.

**Three-way merge:**
- The client sends its `baseVersion`. The server diffs client against base (from `kv_history`) to get the client's **intent**: added, removed and edited ids.
- That intent is then applied to the current server value.
- **Re-arm** (`active:false → true`) counts only if the client's base already contained the trigger (`baseVersion ≥ version that recorded it`). A stale client still showing `active:true` cannot cancel a server trigger or cause a second push.
- **Deleted ids** are tombstoned for 30 days, so a stale client cannot resurrect them.
- **Ids added elsewhere** are not removed by a stale client.
- **If the base has aged out of history:** treat as compare-and-swap, return 409, and the client re-hydrates.

### 2.6 Notifications

**Provider interface:** `NotificationProvider { id, isConfigured(), send({title, message, priority, url, tags}) → {ok, retryable, error} }`.

**Gotify:**
- Request: `POST {GOTIFY_URL}/message`, header `X-Gotify-Key`.
- Payload: `{title, message, priority, extras: {"client::notification": {click: {url}}, "client::display": {contentType: "text/plain"}}}`.
- Click URL: `PUBLIC_URL/#s=SYMBOL`.

**Outbox:**
- Exponential backoff with jitter, from 5 s to 30 min, up to `NOTIFY_MAX_ATTEMPTS` (default 8).
- 4xx is permanent, except 408 and 429. 5xx and network errors are retried.
- The outbox persists across restarts.
- Delivery is at-least-once. A rare duplicate is possible only on a crash between sending and committing; this is documented.

**Testing a notification:** `POST /api/selfhost/notify/test` sends synchronously and reports the exact result. `cli.mjs notify-test` does the same.

**Config:** `GOTIFY_URL`, `GOTIFY_TOKEN` or `GOTIFY_TOKEN_FILE`, `GOTIFY_PRIORITY` (default 8).
- The token never reaches the client.
- The settings page shows only "configured: yes/no" and the last delivery status.

**Extending:** ntfy, Apprise, a webhook or Telegram each take one new file plus config.

### 2.7 Security (single user)

**Deployment modes** (owner decision D4: Tailscale, *or* a CNAME reachable from the internet)

- `EXPOSURE=private` (default) assumes LAN or Tailscale.
- `EXPOSURE=public` is for a domain reachable from the internet. Its extra requirements are enforced at startup: the server refuses to start if they are not met.
  - **HTTPS:** TLS terminated by a reverse proxy, with `TRUST_PROXY` set. Requests arriving without `X-Forwarded-Proto: https` are rejected. Cookies are always `Secure`, and responses send HSTS.
  - **Login:**
    - TOTP second factor is mandatory (RFC 6238, built on `node:crypto`; `cli.mjs totp-setup` prints the QR/URI and recovery codes).
    - The password hash must be set, and plain-text `WICKLINE_PASSWORD` is rejected.
    - Login throttling is stricter, with an increasing per-IP delay and a global rate cap that slows logins without locking the owner out.
  - **API tokens:** disabled unless `ALLOW_API_TOKENS_PUBLIC=true`.
  - **Health endpoint:** `/api/health/ready` returns only `{ok:true}`.
  - **Audit log:** logins, failures, token use and imports are recorded, in the database and in stdout.
- **Recommended over port-forwarding:** Cloudflare Tunnel plus Cloudflare Access, or Tailscale Funnel/Serve, so the home IP and router ports stay closed. Documented in SELFHOSTED.md, with a Caddy/NPM example for those who port-forward anyway.


**Authentication**
- **Second factor:** TOTP, optional in private mode and mandatory in public mode.
- **Password:** `WICKLINE_PASSWORD_HASH` (scrypt via `node:crypto`, generated with `cli.mjs hash-password`), or `WICKLINE_PASSWORD` / `_FILE`, which is hashed at boot.
- **Login:** at `/selfhost/login`. The URL fragment is preserved across login.
- **Session cookie** `wl_session`:
  - `HttpOnly`, **`SameSite=Lax`**, so following a Gotify link still arrives logged in;
  - `Secure` when HTTPS is detected (`COOKIE_SECURE=auto`, which honours `TRUST_PROXY`);
  - 30-day sliding expiry, stored in SQLite.
- **API tokens:** optional bearer tokens.
- **No-auth mode:** `AUTH_MODE=none` requires `I_UNDERSTAND_NO_AUTH=true` and logs a loud warning.

**Coverage**
- Every route needs authentication, including static files, upstream `/api/*`, `/api/health` and the Yahoo SSE stream.
- The only exceptions are:
  - `/api/health/ready`, which returns `{ok:true}` only;
  - `/selfhost/login`, its POST, and its CSS.
- Unauthenticated `/api/*` gets a **401 JSON** response, never a redirect. HTML routes get a 302 to the login page. boot.js redirects to login when it sees a 401.

**CSRF and CORS**
- Every non-GET request must pass an `Origin`/`Host` check, which honours `TRUST_PROXY`.
- Selfhost mutations also require the header `X-Wickline-Selfhost: 1`.
- Upstream has no state-changing GET requests (server.mjs:1063).
- CORS `*` is stripped through the `writeHead` wrapper (§2.2) and tested against a real upstream route and the SSE route.

**Brute-force protection:** an increasing per-client delay, keyed by client IP or by the `TRUST_PROXY` forwarded address. There is no global lockout, so a LAN device cannot lock the owner out.

**Input validation**
- Body limit of 2 MB (configurable).
- Key names must match the allow-list regex.
- Values must be valid JSON within per-key size caps.
- Alerts and scripts are checked against a schema.
- Imports are validated before any write.

**Response headers**
- `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy`.
- The CSP is report-only at first, because upstream has an inline script and `unsafe-eval` in the worker. The snapshot is JSON-escaped data and is never executed (§2.3.1).

**Secrets:** environment variables or `*_FILE` only. They are redacted in logs and the config dump, and never stored in the DB or sent to the browser. A grep-based test enforces this.

**Container:** non-root (99:100, overridable), read-only root filesystem (only `/data` and `/tmp` writable), `no-new-privileges`, `cap_drop: ALL`.

### 2.8 Container

**Dockerfile** (`selfhost/Dockerfile`, multi-stage, `node:24-slim`):
- **Deps stage:** `npm ci --omit=dev --ignore-scripts`, which installs `undici` only, with no Electron.
- **Runtime stage:** copies `server.mjs`, `lib/`, `public/`, `community/`, `package.json`, `LICENSE`, `node_modules/` and `selfhost/` (without tests).
- **Labels:** OCI labels carry the upstream version, the selfhost revision and the git SHA.
- **Settings:** `ENV HOST=0.0.0.0 PORT=5173 DATA_DIR=/data NODE_ENV=production`, `USER 99:100`, `VOLUME /data`, `EXPOSE 5173`, `STOPSIGNAL SIGTERM`.
- **Healthcheck:** `HEALTHCHECK` calls `node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health/ready')…"`. It reports ready when the DB is reachable and the worker heartbeat is less than 60 s old.

**Build:** multi-arch, amd64 and arm64.

**Graceful shutdown** on SIGTERM or SIGINT:
1. Close the public and internal listeners to new connections.
2. Stop the worker and flush `alert_meta`.
3. Finish the in-flight outbox send (5 s limit).
4. End SSE clients and call `closeAllConnections()` on both servers.
5. Checkpoint the WAL, close the DB, and **call `process.exit(0)` explicitly**, because upstream's streamer timers have no stop API.
6. A hard 10 s timeout ends the process if any step hangs.

**`docker-compose.yml`:** volume, env file, `init: true`, healthcheck, `restart: unless-stopped`, `read_only`, `cap_drop`, bridge network.

**`unraid/wickline.xml`:** `/mnt/user/appdata/wickline:/data`, port, password hash, Gotify fields (masked), `TRUST_PROXY`, WebUI link, icon.

### 2.9 Paper trading (optional phase): feasibility

**What already works**
- The engine is reusable as-is: `PaperAccount` is deterministic and safe to run in Node.
- In Phases 2–4 `paper` syncs with **compare-and-swap**, so a stale device can no longer roll an account back.
- Fills still execute only in an open main window.

**What blocks server-side execution: two executors**
- The browser always runs `tick()` itself (trading.js).
- A clean design needs **one small upstream hook**: a remote execution backend for `TradingPanel`. The browser would submit order *intents* with client-generated UUIDs and render server state, without running `tick()` locally.

**Server design**
- **Execution:** the server is the only executor, processing ticks one at a time from the same adapters, with a per-account monotonic `seq`.
- **Idempotency:** `UNIQUE(intent_id)` and `UNIQUE(order_id)` per fill.
- **Audit:** an append-only journal of ticks and decisions, so execution can be replayed and audited.
- **Gap policy:** after downtime, fills happen at the first post-restart price (a documented deviation from upstream).

**Recommendation:** propose the hook upstream first. Ship server execution behind `PAPER_SERVER_EXECUTION=true`.

---

## 3. Architectural Decision Records (full text in `selfhost/docs/adr/`)

**ADR-001 · Wrap, don't modify.** Capture upstream `handleRequest` from `startServer()` and delegate to it in-process from our own public server.
- *Rejected:* editing `server.mjs`; a separate proxy process.
- *Why:* zero upstream edits and a single process. The risk is the undocumented "one listener" shape. A contract test guards it, and the fallback is piping to the internal listener.

**ADR-002 · Storage abstraction at the localStorage boundary** (boot.js plus the injected snapshot).
- *Rejected:* making `util.js store` pluggable; an async store.
- *Why:* three modules bypass `store`, and about 48 call sites read synchronously. One contained file covers all of it, and upstream modes are untouched. A future upstream PR could route everything through `store`.

**ADR-003 · Escaped JSON snapshot inlined in the HTML.**
- *Rejected:* a blocking XHR; top-level await.
- *Why:* no extra round trip, and it also covers the inline theme script. Security comes from the JSON data block with `\u` escaping plus `no-store`.

**ADR-004 · Conflict policy per key:** compare-and-swap for large blobs, three-way id-merge for `scripts` and `alerts`, last-write-wins only for scalar preferences.
- *Rejected:* last-write-wins everywhere (v1); CRDTs; normalized per-entity tables.
- *Why:* upstream keeps long-lived in-memory blobs and writes them on unload, so a stale device must lose its edit rather than overwrite newer data. Normalizing would couple us to upstream schemas.

**ADR-005 · `node:sqlite` built in.**
- *Rejected:* better-sqlite3; JSON files; Postgres.
- *Why:* no dependency, no native build, multi-arch is trivial. The experimental API is isolated in `db.mjs`.

**ADR-006 (v2) · Native quote adapters.** Yahoo goes through the upstream relay's SSE on the loopback; Binance and Coinbase go direct. Everything runs in a supervised worker thread.
- *Rejected:* importing upstream `QuoteStream` under a browser-globals shim (v1); a headless browser.
- *Why:*
  - The shim loses the `m` flag, mixes polled and streamed prices, and can crash the process on an uncaught handler exception.
  - It memoizes static mode if its one health probe fails.
  - Reuse is kept where it matters: the Yahoo server logic.

**ADR-007 · The server is the only push notifier.** The browser keeps its in-page alerts. Dedup uses the trigger identity `id:triggeredAt` plus a dual-window collapse.
- *Rejected:* disabling browser evaluation (needs an upstream edit); `arm_gen` inferred from transitions (v1).
- *Why:* zero upstream edits, and no lost or duplicate push even with stale clients or server downtime.

**ADR-008 · Durable outbox, at-least-once delivery.**
- *Rejected:* fire-and-forget; exactly-once.
- *Why:* survives restarts and Gotify outages.

**ADR-009 · Single-user session cookie (scrypt, `SameSite=Lax`).**
- *Rejected:* basic auth; OIDC; trusting Tailscale headers only.
- *Why:* simple, offline, and works on phones. `AUTH_MODE=tailscale` is a possible later addition.

**ADR-010 · Git model: `main` mirrors upstream (branch only, no tags pushed); `selfhosted` is the default branch.** Integrate the **newest** upstream release with a true merge commit through a PR. Squash and rebase merging are disabled.
- *Rejected:* rebasing; a patch queue; no mirror at all (Fable D3, rejected because the requirements ask for the mirror).
- *Why:* stable history, reviewable PRs, and cherry-picks. `is-ancestor` detection only works with merge commits.

**ADR-011 · All selfhost code under `selfhost/`.** New workflows are prefixed `selfhost-`. The root `package.json` is untouched.
- *Rejected:* adding scripts or dependencies to the root.
- *Why:* upstream rewrites `package.json` every release.

**ADR-012 · Disable upstream workflows through repository settings.** The sync job verifies through the API that every non-`selfhost-*` workflow is disabled, and fails loudly if not.
- *Rejected:* editing or deleting the workflow files.
- *Why:* files stay identical to upstream, and the setting, which lives outside git, is checked continuously.

**ADR-013 · Paper-trading server execution is deferred and depends on an upstream hook.**
- *Rejected:* monkeypatching `TradingPanel`.
- *Why:* patching a 639-line DOM class at runtime is too brittle.

**ADR-014 · The sync workflow runs untrusted upstream code only in jobs without secrets.**
- *Rejected:* a single job holding `SYNC_TOKEN`.
- *Why:* supply-chain containment.

---

## 4. Inventory of upstream files touched

| Upstream file | Modified? | Dependency / contract (`selfhost/INTEGRATION_POINTS.json`) |
|---|---|---|
| `server.mjs` | **No** | The `startServer` → `{server}` export with one request listener. `writeHead`-based headers. `/api/yahoo/stream` (≤ 100 symbols, ticks carry `m`), `/api/yahoo/quotes` and `/api/yahoo/chart` meta. Script-mode proxy init. |
| `public/index.html` | **No** | The `<head>` anchor. The inline theme script reads `wickline.theme` and `wickline.paint`. |
| `public/js/util.js`, `drawings.js`, `scripts.js`, `i18n.js`, `theme.js` | **No** | The `wickline.` prefix. Storage listeners (`alerts`, `paper`, `scripts`, `lang`). The `scripts` entry shape `{id, updated}`. |
| `public/js/app.js` | **No** | The hash format `s`/`tf`, which boot.js strips before a sync reload. The `workspace` shape. |
| `public/js/alerts.js` | **No** | The alert JSON schema and crossing semantics (parity contract test). |
| `public/js/datafeed.js` | **No** | Binance and Coinbase public endpoints and message shapes, mirrored by our adapters (contract test). |
| `public/js/paper.js`, `trading.js` | No (Phases 0–4). The optional phase adds one hook to `trading.js`, offered upstream first. | — |
| `lib/proxy.mjs` | **No** | `envProxy`, `setServerProxy`. |
| `package.json`, lockfile | **No** | `npm ci --omit=dev`. |
| upstream `.github/workflows/*` | **No** (disabled through settings, verified by the sync job) | — |

CI check `selfhost-ci › upstream-untouched`: `git diff --name-only <merged-upstream-tag>..HEAD` must list only `selfhost/**`, `.github/workflows/selfhost-*`, the five root docs and the plan.

---

## 5. Upstream maintenance strategy

### 5.1 Branches and settings

- **`main`:** a fast-forward-only mirror of `upstream/main`. Only the branch is pushed; **upstream tags are not pushed to the fork**, so `release.yml` can never be triggered. It is never deployed.
- **`selfhosted`:** the default branch, protected, requires CI. **Merge commits only** (squash and rebase are disabled in settings, and the sync job checks this).
- **`integrate/upstream-vX.Y.Z`:** a temporary branch from `selfhosted` with `git merge --no-ff <upstream tag>` (fetched inside the job). A PR from it goes into `selfhosted`.
- **`hotfix/upstream-<sha>`:** cherry-picks one upstream commit (`workflow_dispatch`, input `sha`). Label `upstream-cherry-pick`. A later full merge resolves trivially.
- **`feat/*`:** our own work, merged into `selfhosted` by PR.
- Every `gh pr` / `gh issue` call passes **`--repo mtrifan/wickline`**. In a fork, `gh` defaults to the parent repository.

### 5.2 Tags and versions

- Our release tags are `sh-v<upstream>-<rev>` (e.g. `sh-v0.1.9-1`). They do not match upstream's `v*` trigger.
- `selfhost/VERSION` holds `<rev>`. The upstream version comes from `package.json`.

### 5.3 Daily sync workflow (`selfhost-upstream-sync.yml`)

> **Implemented in Phase 0, with hardening from the Phase 0 security review.** The authoritative description is now [UPSTREAM.md](../../UPSTREAM.md). Differences from the outline below:
> - Validation is three separate jobs (trusted untouched check, selfhost tests, upstream tests).
> - Markers are `<!-- upstream-sync:<kind>:<version> -->`, recognised only at the start of a body.
> - Any upstream change to `.github/workflows/**`, or to fork-owned paths, produces a manual-integration issue instead of a push.
> - The token additionally needs Variables (read/write) and Actions (read).
> - Playwright and Docker validation join the validate stage in Phases 1–2.
> - The `needs-review` label is not used.

Runs on cron at 05:17 UTC and on `workflow_dispatch`. It is split into **three jobs**: a job that holds the token never runs repository code.

**Job A: `prepare`** (permissions `contents: read`, no secrets)
- Checks out `selfhosted` and fetches upstream with tags.
- Finds the newest published upstream release, not drafts. Tags are a fallback.
- Checks `is-ancestor` → already integrated?
- **Duplicate guard:** looks for an open PR or issue labelled `upstream-sync` with the hidden marker `<!-- upstream-sync:vX.Y.Z -->`. It also reuses the deterministic branch name.
- Merges the tag locally (`--no-ff`).
- On conflict, it collects the conflicting files, the integration points they touch, the upstream changelog and the local resolution commands.
- Computes:
  - the integration points touched: the upstream diff intersected with `INTEGRATION_POINTS.json`;
  - new or changed upstream workflow files;
  - commits on `upstream/main` after the latest tag (unreleased).
- Uploads the merged tree as a git bundle artifact, plus `report.json`.

**Job B: `validate`** (`contents: read`, no secrets, `persist-credentials: false`, needs A, skipped on conflict)
- Restores the bundle.
- Runs `npm ci --ignore-scripts`, upstream `npm test`, then selfhost unit, contract and API tests, Playwright (Chromium), and a Docker build plus a container smoke test.
- Uploads the results.

**Job C: `publish`** (uses `SYNC_TOKEN`, **runs no repository code**, needs A and B)
- Asserts the repository settings: merge commits only, and all non-`selfhost-*` workflows disabled.
- Fast-forwards `main` (the branch only). If upstream force-pushed, it opens an issue instead.
- Depending on the outcome:
  - **Clean merge, validation passed:** push the `integrate/…` branch and open a PR. The body has the release notes, the commit list, the integration points touched, new workflow files, skipped intermediate versions and a checklist. Labels `upstream-sync`, `needs-review`.
  - **Conflict:** open or update the issue "Upstream vX.Y.Z: merge conflicts" with the details from Job A.
  - **Validation failed:** push the branch for debugging and open or update an issue with the failing jobs and log excerpts. No PR.
- Updates the single rolling issue "Upstream: unreleased changes", or closes it once a release covers those commits.
- Writes the time of the last successful run (a repository variable). A separate weekly job raises an issue if that time is older than 3 days. This catches the GitHub rule that disables scheduled workflows after 60 days without activity, and PAT expiry.
- **Never auto-merges, never deploys.**

**`SYNC_TOKEN`:** a fine-grained PAT on `mtrifan`, scoped to this repository only: contents, pull-requests, issues, workflows and administration:read (for the settings assertion), with a 90-day expiry. Renewal is documented in UPSTREAM.md. The default `GITHUB_TOKEN` cannot trigger CI on the PRs it creates, and cannot push upstream changes to `.github/workflows`.

### 5.4 Docker release management

| Tag | Source | Gate |
|---|---|---|
| `:0.1.9-sh.1` (immutable) | git tag `sh-v0.1.9-1` on `selfhosted` | full suite plus restart, migration and backup tests |
| `:0.1.9` (latest selfhost revision for that upstream version) | same | same |
| `:stable` = `:latest` | promoted from a release tag | the above **plus** manual approval in the `production` environment |
| `:edge` | every push to `selfhosted` | CI |
| `:experimental` | `integrate/upstream-main` (optional) | CI |
| `:sha-<short>` | every build | — |

- Images go to `ghcr.io/mtrifan/wickline` (public): multi-arch, with SBOM and provenance attestations.
- **No image is published before authentication exists** (Phase 1 contains auth).
- **Rollback:** pin the previous immutable tag, then restore the automatic `pre-migrate-*.db` backup, which is needed only if the schema changed. This runs through `cli.mjs restore`, which bumps `epoch`. Details are in UPGRADE.md.

---

## 6. Testing strategy

| Layer | What | Where |
|---|---|---|
| Upstream unit (unchanged) | `npm test` | every PR and sync |
| Selfhost unit (`node:test`) | config, key policies, CAS, three-way merges (alerts, scripts), trigger dedup, evaluator, market-hours, price-chain hygiene, outbox backoff, auth, scrypt, migrations, snapshot escaping | `selfhost/package.json` |
| Contract (upstream compatibility) | `startServer` listener shape; `<head>` anchor; `wickline.` prefix and storage listeners; `writeHead`-based CORS stripped; `/api/yahoo/stream` tick shape with `m` and the 100-symbol cap; evaluator parity with `AlertManager.check`; Binance and Coinbase message shapes versus `datafeed.js`; `scripts` entry shape; hash format | every CI run; each failure names its integration point |
| API integration | selfhost on port 0, temp DB, fake Yahoo relay, fake Binance WebSocket, fake Gotify | CI |
| Alerts without a browser | create via API → fake ticks → exactly one Gotify POST; re-arm → one more; restart mid-stream → no duplicate; short-gap resume fires once; long gap ignores the first tick; malformed frame → worker restarts, UI unaffected | CI |
| Alert merge matrix | stale-base add, delete, clearTriggered, post-trigger re-arm; re-arm plus trigger while server down; browser and server trigger the same crossing; tombstone resurrection | CI |
| Playwright (two independent `browser.newContext()`s) | log in on both; watchlist, scripts, alerts, drawings and theme sync; device-local keys do not sync; CAS conflict notice; different hashes, both hidden → no ping-pong; main plus two pop-outs over HTTP/1.1 → one events connection per profile; offline edit uploads on reconnect; the same-origin guard offers a backup download; restore epoch → re-hydrate; upstream mode (`node server.mjs`) has **no** injection | CI on Chromium; Firefox and WebKit nightly |
| Docker | build; run on a tmp volume; healthy; seed; `docker restart` → data and alert state intact; SIGTERM → exit 0 within 10 s with SSE open; uid ≠ 0; read-only rootfs | CI |
| Migrations | fixture DBs captured at each selfhost release, migrated to head; downgrade refused | CI |
| Backup / restore | `VACUUM INTO` → restore through the CLI → data equal, `epoch` bumped | CI |
| Security | every upstream `/api/*` route (listed from `server.mjs`) returns 401 when unauthenticated; cross-origin POST rejected; no secret in logs, HTML or responses; `ACAO` header absent | CI |
| Desktop regression | upstream `npm test` + `WICKLINE_SMOKE_TEST` Electron e2e under xvfb | nightly, non-blocking (needs internet) |

`SELFHOST_TEST_MODE=1` selects the fake sources. The server refuses it when `NODE_ENV=production`.

---

## 7. Phased implementation plan

Each phase is a sequence of atomic conventional commits on `feat/*`, delivered by PR into `selfhosted`. A phase is done only when its acceptance criteria pass in CI. Commits use the **personal** git identity configured locally in the repository.

### Phase 0: fork, upstream strategy, CI skeleton

1. Fork to `mtrifan/wickline`. Create `selfhosted` from `v0.1.9` as the default branch. Branch protection. Merge commits only. `gh workflow disable` for `release.yml`, `pages.yml` and `community.yml`.
2. `selfhost/` skeleton, `selfhost/package.json`, `INTEGRATION_POINTS.json`, the contract suite (against v0.1.9), and the `upstream-untouched` check.
3. `selfhost-ci.yml` on every PR and push.
4. `selfhost-upstream-sync.yml` (the three-job design in §5.3) with a `dry_run` input, plus the staleness job.
5. Doc skeletons: UPSTREAM.md, ARCHITECTURE.md (from this plan), SELFHOSTED.md, CHANGELOG-SELFHOSTED.md, UPGRADE.md.

**Acceptance criteria**
- CI is green.
- `upstream-untouched` passes.
- A sync dry run against a sandbox branch pinned to `v0.1.8`:
  - detects `v0.1.9`;
  - validates it in Job B with no secrets;
  - produces the PR body with the integration-point report;
  - creates nothing new on a second run.
- A deliberately conflicting sandbox change produces an issue, not a PR.
- `main` equals `upstream/main`, and the fork has no upstream tags.
- The settings assertion fails if a workflow is re-enabled.

### Phase 1: headless container with authentication

1. `selfhost/server.mjs` and `config.mjs`: the wrapper, the `writeHead` CORS strip, security headers, graceful shutdown, `/api/health/ready`, logs with secrets redacted.
2. Auth: sessions, login page with fragment preserved, TOTP, `EXPOSURE=public` startup enforcement, audit log, `hash-password` CLI, API tokens, CSRF, `TRUST_PROXY`, increasing delay on failed logins, `AUTH_MODE=none` guard, 401 JSON for `/api/*`.
3. Dockerfile, the dockerignore file, compose, Unraid XML.
4. `selfhost-docker.yml`: multi-arch build; push `:edge` / `:sha-*` to GHCR.

**Acceptance criteria**
- `docker compose up` serves the full upstream UI after login, and stocks load through the relay.
- Every route outside the allow-list returns 401 (API) or 302 (HTML). The test enumerates every upstream `/api/*` route.
- `ACAO: *` is absent everywhere.
- Healthy within 20 s.
- `docker stop` → exit 0 within 10 s with an SSE stream open.
- uid 99. Read-only rootfs works. Image under 250 MB with no Electron.
- Login works on Chromium and WebKit, including TOTP.
- `EXPOSURE=public` refuses to start without HTTPS, a password hash and TOTP. Requests without `X-Forwarded-Proto: https` are rejected.
- A cross-origin POST is rejected.
- No secrets leak.
- `npm start` and the desktop app behave exactly like upstream (Playwright upstream-mode test plus upstream `npm test`).

### Phase 2: persistent storage and cross-device sync

1. `storage/`: db, migrations, pre-migration backup, downgrade guard, `kv_state` with tombstones and `rev`, `kv_history`, epoch.
2. Sync API: `GET` snapshot, `PUT` / `DELETE` with key policies (CAS, LWW, the `scripts` three-way merge), SSE hub with `Last-Event-ID` resume.
3. `boot.js`: escaped-JSON injection, hydration, no-op suppression, dirty-set outbox, leader election and one events connection per profile, remote apply, banner, apply-on-visible, hash strip, status dot, 401 → login.
4. Same-origin guard (backup download, then server data wins); `SYNC_WORKSPACE` opt-out.
5. Backup scheduler, download, JSON export/import, `cli.mjs restore` with an epoch bump.

**Acceptance criteria**
- All Phase-2 Playwright scenarios in §6 pass:
  - two-context sync;
  - device-local keys stay local;
  - CAS notice;
  - no ping-pong;
  - pop-outs share one connection;
  - offline queue;
  - the same-origin guard;
  - restore epoch.
- Concurrent PUTs: versions strictly increase. The stored value equals the highest accepted version. Every connected client converges within 5 s.
- A stale `beforeunload` `paper` write is rejected with 409.
- The snapshot escaping test passes with `</script>` and `<!--` payloads.
- State survives `docker restart`.
- Migration v1 applies. A synthetic v2 migration proves the pre-migration backup and the downgrade refusal.
- Backup → restore round-trip is equal.
- JSON export → import into a fresh container reproduces all synced state.
- Upstream-mode and desktop regressions stay green.

### Phase 3: background alerts and Gotify

1. Worker thread with supervisor and heartbeat. Adapters: Yahoo loopback SSE with sharding, Binance, Coinbase, REST fallback.
2. Evaluator, price-chain hygiene, market hours, staleness, resume.
3. `alert_meta`, the `alerts` three-way merge, trigger identity and dual-window collapse.
4. Notifier: provider interface, Gotify, outbox, test endpoint, settings status.

**Acceptance criteria**
- Every "Alerts without a browser" and "Alert merge matrix" case in §6 passes.
- A server trigger shows as triggered in an open browser through SSE within 5 s.
- Gotify returning 500, 500, 500, then 200 delivers exactly one message, with the attempts logged.
- The test notification reports success or the precise error.
- A closed Yahoo market produces no stale alarm. A stale symbol never fires.
- Intervals are configurable and validated.
- More than 100 Yahoo symbols are all streamed (sharded).
- A malformed frame restarts only the worker, and readiness reflects it.
- A manual smoke test on Unraid with real Gotify and `BINANCE:BTCUSDT` passes (documented, not automated).

### Phase 4: release management, full regression suite, documentation

1. `selfhost-release.yml`: an `sh-v*` tag → full suite → immutable and per-upstream tags → `:stable` / `:latest` after `production` approval.
2. A migration fixture captured for each release. Backup/restore CI. A nightly cross-browser and desktop-e2e workflow.
3. Full docs:
   - SELFHOSTED.md: install via Unraid or compose, configuration reference, Tailscale Serve HTTPS, Gotify setup, known limitations.
   - UPGRADE.md: upgrade, rollback, restore.
   - UPSTREAM.md: integration runbook, conflicts, cherry-picks, PAT renewal, maintenance duties.
   - ARCHITECTURE.md and CHANGELOG-SELFHOSTED.md.

**Acceptance criteria**
- `sh-v0.1.9-1` publishes `:0.1.9-sh.1` and `:0.1.9`. `:stable` follows only after approval. `:edge` and `:experimental` never move `:latest`.
- A documented upgrade `sh-v0.1.9-1` → `sh-v0.1.9-2` with a schema change preserves data, and the documented rollback restores it.
- An end-to-end simulated upstream release in a sandbox produces a correct PR.

### Phase 5 (optional): server-side paper trading

1. Upstream PR for the `TradingPanel` remote-backend hook. If upstream declines, carry a minimal documented patch and list it in §4.
2. Server executor reusing `PaperAccount`: intents API, idempotency, serial processing, journal, gap policy, behind `PAPER_SERVER_EXECUTION`.

**Acceptance criteria**
- A golden test gives identical fills from the browser engine and the server engine for the same ticks.
- A duplicate intent produces one order.
- Concurrent tabs cannot double-fill.
- A restart does not re-apply fills.
- With the flag off, behaviour equals Phase 4 exactly.

---

## 8. Risks

| Risk | L / I | Mitigation |
|---|---|---|
| Upstream changes one of: the `<head>`, the `wickline.` prefix, `startServer`, the relay stream shape, the alert schema, or the hash format | High / Med | Contract tests name the broken point. The sync PR lists touched integration points. Job B runs before any PR exists. |
| Patching `Storage.prototype` interferes with upstream | Low / Med | Allow-listed keys only, original semantics kept, Playwright regression, no-op suppression |
| CAS loses a small local edit on conflict | Med / Low | A visible notice and the stale value is offered as a download. This beats overwriting newer data (v1). |
| Stale tab or `beforeunload` writes | Med / Med | Rejected server-side by CAS / three-way merge. |
| HTTP/1.1 connection limit with many windows | Med / Med | One events connection per profile (leader). HTTPS via Tailscale Serve gives HTTP/2. |
| Yahoo throttles a 24/7 server IP | Med / High | Upstream relay cache, one sharded stream, staleness detection with notification, proxy support |
| Missed crossings during long downtime or a closed market | Med / Med | Resume window, documented. A future option checks bar high/low on resume. |
| Worker crash | Low / Med | `worker_threads` isolation, supervisor, guarded handlers, readiness |
| Malicious or compromised upstream release | Low / High | Upstream code runs only in a secret-less job. No auto-merge or auto-deploy. Human review of the PR. |
| Sync silently stops (cron disabled after 60 days, PAT expiry) | Med / Med | Staleness job raises an issue; PAT renewal runbook. |
| `node:sqlite` API changes | Low / Med | Isolated in `db.mjs`, Node pinned in the image, swap path documented |
| Upstream adds `ARCHITECTURE.md` or `UPGRADE.md` | Low / Low | The sync report detects it; rename ours to `*-SELFHOSTED.md`. |
| Host networking exposes the internal relay listener to host processes | Low / Low | It holds no user data. Bridge networking recommended and documented. |
| External review tooling ran under organization budgets | — | Process note: use personal API keys for this project's agent tooling going forward. |

## 9. Owner decisions (2026-11-24)

| # | Decision | Effect on the plan |
|---|---|---|
| D0 | Plan approved | Start Phase 0 |
| D1 | No existing data; fresh start | Cross-origin migration dropped; same-origin guard and JSON export/import kept |
| D2 | Share across devices | `workspace` synced by default (CAS); opt-out `SYNC_WORKSPACE=false` |
| D3 | Alerts may fire in pre- and post-market | `ALERT_EXTENDED_HOURS=true` by default, with a separate price chain per session; stays in Phase 3 |
| D4 | Tailscale, or a CNAME on the internet | `EXPOSURE=public` mode added to Phase 1 (HTTPS required, mandatory TOTP, audit log, stricter throttling); Cloudflare Tunnel/Access recommended |
| D5 | Sync bot token OK | Fine-grained PAT `SYNC_TOKEN` on mtrifan, created by the owner in the GitHub UI during Phase 0 |

### Remaining open questions (non-blocking; defaults apply unless the owner says otherwise)
~~1. **`workspace` sync** (layouts, every chart's symbol/timeframe/indicators): keep it per-device by default with an opt-in (proposed), sync it by default, or sync only the layout?~~ (decided)
~~2. **Existing data:** where does it live today: the desktop app, a browser, or nowhere (fresh start)? This decides whether the export snippet is enough or the Electron LevelDB importer is worth building.~~ (decided)
~~3. **Extended hours:** should alerts fire on pre- and post-market ticks? Proposed default: regular session only for server pushes. Upstream parity would be "all ticks".~~ (decided)
4. **Unraid:** UID:GID 99:100? Bridge networking (recommended) or host?
5. **Access path:** Tailscale Serve (HTTPS, HTTP/2, sets `TRUST_PROXY`), plain LAN HTTP, or both? Is password + session enough, or do you also want `AUTH_MODE=tailscale` in the first release?
6. **Running two devices at once:** do you expect both main windows open at once? Each runs its own paper fills until the paper-trading phase. Alerts are safe either way.
7. **Push when the browser already showed it:** keep the push (proposed), or suppress it when a browser on any device showed the alert within N seconds?
8. **Yahoo alert symbols:** expected count? More than 100 is supported through sharding but costs more upstream load.
~~9. **`SYNC_TOKEN`:** OK to create a fine-grained PAT on `mtrifan`? You'll also need `gh auth refresh -h github.com -u mtrifan -s workflow,write:packages` for local pushes of workflow files.~~ (decided)
10. **Daily automation:** comfortable with a daily unattended job running new upstream code in a secret-less sandbox job?
11. **Paper-trading phase:** pursue the upstream hook PR, or skip server-side paper trading?
12. **Notifications:** include the price and a deep link (needs `PUBLIC_URL`, e.g. a Tailscale MagicDNS name)?

## 10. Assumptions

- One user, a handful of devices, fewer than 200 alert symbols, user data under 10 MB.
- Private mode: LAN or Tailscale. Public mode: a reverse proxy or tunnel terminates TLS (see §2.7).
- Outbound internet access to Yahoo, Binance and Coinbase, or a proxy through `WICKLINE_PROXY`.
- Price-level alerts only, matching upstream. Indicator-based alerts would need server-side user-JS sandboxing and are out of scope.
- Node 24 LTS in the container. Upstream `engines` is `>=22`, so this is compatible.

---

## 11. Revision log: v1 → v2 (Fable 5.2 design review)

The review produced 25 findings. Six were spot-checked against the source and all six held (F1, F5, F6, F9, F10, F13). The rest were accepted on the evidence the review cited.

| Finding | Severity | Change |
|---|---|---|
| F1 | critical | Hash overrides the hydrated workspace, and auto-reload ping-pong → strip the hash before a sync reload, suppress no-op writes, apply on visible instead of reloading while hidden; `workspace` becomes device-local by default (Q1). |
| F2 | critical | Stored XSS through the inlined snapshot → `type="application/json"` with `\u` escaping, `no-store`, payload tests. |
| F3 | high | Lost push via `arm_gen` → trigger identity `id:triggeredAt`. |
| F4 | high | Duplicate pushes and resurrected alerts → three-way merge against `kv_history` with tombstones. |
| F5 | high | `m` and `marketState` were unavailable through `QuoteStream` → native Yahoo adapter on the relay SSE; open/closed from chart meta; price-chain hygiene. |
| F6 | high | Browser code can crash the server → native adapters with guarded handlers in a supervised worker thread. |
| F7 | high | Untrusted code ran with the write PAT → three-job sync workflow. |
| F8 | high | HTTP/1.1 connection limit and multi-tab races → leader election, per-profile `clientId`, per-key version entries. |
| F9 | high | LWW destroyed data on stale writes → CAS for blob keys, id-merge for scripts. |
| F10 | medium | CORS via `setHeader` → `writeHead` wrapper. |
| F11 | medium | Health route contradiction → only `/api/health/ready` is open; `/api/*` returns 401 JSON. |
| F12 | medium | Tombstones, `rev` and restore epoch added. |
| F13 | medium | Yahoo 100-symbol cap → sharding. |
| F14 | medium | Merge commits only; integrate the newest release. |
| F15 | medium | No tag mirroring; settings assertion; `--repo`. |
| F16 | medium | Write capture held until the migration decision; local backup taken first. |
| F17 | medium | Memoized `dataMode` → moot (shim dropped). |
| F18 | medium | No image published before auth → auth merged into Phase 1. |
| F19 | low | `SameSite=Lax`; fragment preserved. |
| F20 | low | Increasing delay instead of lockout; `TRUST_PROXY`. |
| F21 | low | Outbox stores dirty keys only. |
| F22 | low | Explicit `process.exit`. |
| F23 | low | Sync staleness alarm; PAT renewal. |
| F24 | low | Reference corrections. |
| F25 | low | Testable convergence criteria. |

**Not adopted:** D3 ("no `main` mirror"). The requirements explicitly ask for `main` as an upstream mirror. We keep it (branch only) and add safeguards.
