# Changelog: Wickline Self-Hosted

Changes specific to the self-hosted edition. For the app itself, see the upstream [releases](https://github.com/keptaduona/wickline/releases).

Release tags: `sh-v<upstream version>-<revision>`. Image tags: `<upstream version>-sh.<revision>`.

## Unreleased

## sh-v0.1.9-1 — 2026-11-26

The first release. Images: `ghcr.io/mtrifan/wickline:0.1.9-sh.1` (immutable), `:0.1.9`, and `:stable` / `:latest` after approval.

### Added
- Releases and regression safety (Phase 4):
  - Release workflow for `sh-v*` tags. It checks the tag against the version files and the changelog, runs the full suite and the container tests, and publishes immutable images with SBOM and provenance plus a GitHub release. `:stable` and `:latest` move only after approval.
  - Migration fixtures for every schema version, frozen in CI: each must upgrade to the current schema with every row intact.
  - A container upgrade-and-rollback test on every change. A nightly run of the browser suite on Chromium, WebKit and Firefox, and of upstream's desktop end-to-end test.
  - Documentation: Unraid install and update, configuration, architecture, upgrade and rollback, release steps.
- Server-side alerts and push notifications (Phase 3):
  - Gotify notifications through a durable outbox: retries from 5 s to 30 min, one push per alert trigger however many devices report it, a test command (`cli.mjs notify-test`) and status (`/api/selfhost/notify/status`).
  - Alerts checked on the server around the clock, in a supervised worker thread: Yahoo through upstream's own relay, Binance spot and futures, Coinbase. Upstream's crossing rules (pinned by a contract test), one price chain per market session (`ALERT_EXTENDED_HOURS`), resume after a short restart.
  - Market hours, REST fallback when a stream goes quiet, stale detection and optional notices (`ALERT_POLL_INTERVAL`, `ALERT_CLOSED_POLL_INTERVAL`, `ALERT_STALE_AFTER`, `NOTIFY_STALE`), and `/api/selfhost/alerts/status`.
  - The alerts merge: trigger fields are owned by the server, a stale device can neither cancel a trigger nor resurrect a deleted alert (30-day tombstones).
  - One container per data folder (a lock; a second container exits with code 78).
- Storage and sync across devices (Phase 2):
  - Every synced setting lives in SQLite and is shared by all signed-in browsers, with live updates for alerts, the paper account, scripts and language, and a reload banner for the rest.
  - Per-key conflict rules: first write wins with a notice (watchlist, drawings, layout, paper account), entry-by-entry merge (scripts, alerts), last write wins (preferences).
  - Offline edits are kept and sent on reconnect; one tab per browser holds the connection.
  - Daily backups (`BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`), backup download, JSON export and import, and `cli.mjs backup` / `restore` with a new epoch so open browsers reload into the restored data.
- Container and authentication (Phase 1):
  - Docker image (Alpine, Node 24, about 245 MB): runs as UID 99, works with a read-only root filesystem, has a healthcheck (`/api/health/ready`) and stops gracefully on SIGTERM, even with open streams.
  - Docker Compose file and Unraid template.
  - Single-user login: scrypt password hash, optional TOTP with replay protection, `HttpOnly; SameSite=Lax` sessions stored as digests in SQLite (`/data/wickline.db`) that survive restarts, API tokens.
  - Protection on every route except the readiness check: same-origin checks on state-changing requests, upstream's CORS header removed, security headers, increasing per-client login delay, audit log.
  - Public mode (`EXPOSURE=public`): refuses to start without a password hash, TOTP and a trusted HTTPS proxy.
  - `selfhost/cli.mjs`: `hash-password`, `totp-setup`, `token create|list|revoke`, `sessions revoke-all`.
  - Schema migrations with an automatic pre-migration backup; a downgrade is refused.
  - CI: API integration tests, Playwright (Chromium and WebKit, including an upstream-mode check), container smoke test; `:edge` images on GHCR (amd64, arm64) with SBOM and provenance.
- Repository foundation (Phase 0):
  - `selfhost/` workspace;
  - upstream contract tests;
  - CI check that no upstream file is modified;
  - daily upstream synchronisation workflow with a watchdog;
  - maintenance documentation.

Based on upstream **v0.1.9**.
