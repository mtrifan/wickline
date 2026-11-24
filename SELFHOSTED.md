# Wickline Self-Hosted

An unofficial, self-hosted edition of [Wickline](https://github.com/keptaduona/wickline) for running 24/7 in Docker, for example on Unraid. It adds the following on top of the unmodified upstream app:

- **sync across devices:** watchlists, layouts, drawings, custom indicators, alerts and preferences;
- **background price alerts** with Gotify push notifications;
- single-user authentication.

> **Status: in development.** Phase 0 (repository, upstream sync, CI) is in place. Installation instructions arrive with Phase 1 (container and authentication). See [the plan](selfhost/docs/PLAN.md) for the roadmap.

## Contents (filled in as phases ship)

- **Installation:** Unraid template, Docker Compose. *Phase 1.*
- **Configuration reference:** environment variables and secrets (`*_FILE`). *Phase 1.*
- **Access:**
  - Tailscale Serve (recommended), plain LAN;
  - public mode (`EXPOSURE=public`): reverse proxy or Cloudflare Tunnel, HTTPS, mandatory TOTP.
  - *Phase 1.*
- **Sync across devices:** how it works and how conflicts are resolved. *Phase 2.*
- **Alerts and Gotify setup.** *Phase 3.*
- **Backup and restore:** see [UPGRADE.md](UPGRADE.md). *Phases 2 and 4.*
- **Known limitations.**

## Licence

MIT, as upstream. Copyright notices for Wickline contributors and TradingView Lightweight Charts™ (Apache-2.0) are kept in the image.
