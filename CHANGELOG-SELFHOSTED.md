# Changelog: Wickline Self-Hosted

Changes specific to the self-hosted edition. For the app itself, see the upstream [releases](https://github.com/keptaduona/wickline/releases).

Release tags: `sh-v<upstream version>-<revision>`. Image tags: `<upstream version>-sh.<revision>`.

## Unreleased

### Added
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
