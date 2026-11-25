# Wickline Self-Hosted

An unofficial, self-hosted edition of [Wickline](https://github.com/keptaduona/wickline) that runs 24/7 in Docker, for example on Unraid. It runs the unmodified upstream app and adds:

- **single-user login**: password, optional two-factor (TOTP), sessions that survive restarts;
- **sync across devices**: watchlists, layouts, drawings, custom indicators, alerts and preferences *(Phase 2)*;
- **background price alerts** with Gotify push notifications, even with no browser open *(Phase 3)*.

> **Status:** Phase 1 (container and authentication) is complete. Images are published as `ghcr.io/mtrifan/wickline:edge`; `:stable` arrives with the first tagged release (Phase 4). The roadmap is in [the plan](selfhost/docs/PLAN.md).

## Install

You need a **password hash**, not the password itself. Run this anywhere Docker is available, type the password twice (12+ characters), and copy the output, which starts with `scrypt$`:

```sh
docker run --rm -it ghcr.io/mtrifan/wickline:edge node selfhost/cli.mjs hash-password
```

### Unraid

1. **Add the template.** Docker → Add Container → Template repositories. Add `https://github.com/mtrifan/wickline`, or paste the URL of [`selfhost/unraid/wickline.xml`](selfhost/unraid/wickline.xml) as the template URL.
2. **Fill in the fields.**
   - **Password hash:** the `scrypt$…` output from above.
   - **Data:** `/mnt/user/appdata/wickline`. The default owner `nobody:users` (99:100) is what the container runs as.
   - **Exposure:** `private` for LAN/Tailscale.
3. **Apply,** then open the WebUI (`http://<unraid-ip>:5173`).

### Docker Compose

```sh
mkdir -p wickline/data wickline/secrets && cd wickline
sudo chown 99:100 data                     # the container runs as UID 99
curl -fsSLO https://raw.githubusercontent.com/mtrifan/wickline/selfhosted/selfhost/docker-compose.yml
docker run --rm -it ghcr.io/mtrifan/wickline:edge node selfhost/cli.mjs hash-password > secrets/password_hash
chmod 644 secrets/password_hash
docker compose up -d
```

The hash lives in a file (`WICKLINE_PASSWORD_HASH_FILE`) because it contains `$`, which Compose would otherwise expand. The compose file runs the container with a read-only root filesystem and no Linux capabilities.

### Plain `docker run`

```sh
docker run -d --name wickline --restart unless-stopped --init \
  -p 5173:5173 -v /srv/wickline:/data \
  -e 'WICKLINE_PASSWORD_HASH=scrypt$…' \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/mtrifan/wickline:edge
```

Use single quotes around the hash.

## Configuration

Everything is set through environment variables. Each secret also accepts `<NAME>_FILE`, a path to a file holding the value.

| Variable | Default | Meaning |
|---|---|---|
| `WICKLINE_PASSWORD_HASH` | none (required) | Output of `node selfhost/cli.mjs hash-password`. |
| `WICKLINE_PASSWORD` | none | Plain password (12+ characters), hashed at start. Private mode only; prefer the hash. |
| `WICKLINE_TOTP_SECRET` | none | Second factor. Create it with `node selfhost/cli.mjs totp-setup` and add it to an authenticator app. Required in public mode. |
| `EXPOSURE` | `private` | `private` = LAN/Tailscale. `public` = reachable from the internet; see below. |
| `TRUST_PROXY` | `false` | How many reverse proxies sit in front (Tailscale Serve, Nginx Proxy Manager, Caddy, Cloudflare Tunnel): `true` = 1, or a number. Only then are `X-Forwarded-*` headers believed. |
| `TRUSTED_PROXY_IPS` | loopback and private ranges | The proxy addresses (IPs/CIDRs, comma-separated) whose `X-Forwarded-*` headers are believed. Requests arriving directly from any other address are treated as direct clients. Set it to your proxy's address, especially in public mode, e.g. `172.18.0.5` for a proxy container or `100.64.0.0/10` for Tailscale. |
| `COOKIE_SECURE` | `auto` | `auto` marks the session cookie `Secure` when the request arrived over HTTPS. `true` forces it. |
| `SESSION_DAYS` | `30` | A session expires after this many days without use. |
| `ALLOW_API_TOKENS` | `true` | Bearer tokens for scripts (`cli.mjs token create`). In public mode they are off unless `ALLOW_API_TOKENS_PUBLIC=true`. |
| `AUTH_MODE` | `password` | `none` disables login entirely (needs `I_UNDERSTAND_NO_AUTH=true`; never allowed in public mode). |
| `SYNC_WORKSPACE` | `true` | Sync the chart layout (`workspace`) between devices. `false` keeps a separate layout on each device; watchlists, drawings, scripts, alerts and settings still sync. |
| `WICKLINE_PROXY` | none | Outbound HTTP or SOCKS5 proxy for market data (also `HTTPS_PROXY`, `ALL_PROXY`). |
| `PORT`, `HOST`, `DATA_DIR` | `5173`, `0.0.0.0`, `/data` | Listener and data location. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout/stderr. |

An invalid configuration stops the container with exit code 78, listing every problem.

## Access

### LAN and Tailscale (recommended)

Leave `EXPOSURE=private`. Over Tailscale, [Tailscale Serve](https://tailscale.com/kb/1312/serve) adds HTTPS with a valid certificate:

```sh
tailscale serve --bg 5173        # on the Unraid host
```

Then set `TRUST_PROXY=true`, so sessions use secure cookies. The default `TRUSTED_PROXY_IPS` already covers Tailscale Serve, which connects from the host.

### From the internet (`EXPOSURE=public`)

Prefer a tunnel that keeps your router closed: Cloudflare Tunnel (optionally with Cloudflare Access in front), or Tailscale Funnel. If you forward a port, put an HTTPS reverse proxy in front.

Public mode refuses to start unless all of these are set:
- `WICKLINE_PASSWORD_HASH`. A plain password is refused.
- `WICKLINE_TOTP_SECRET`, for two-factor login.
- `TRUST_PROXY`. TLS ends at your proxy, and requests that did not arrive over HTTPS are refused.

Also set `TRUSTED_PROXY_IPS` to your proxy's address, and do not publish port 5173 anywhere else. Forwarded headers are only believed from that address, so a client reaching the port directly cannot pretend to be HTTPS or hide its IP from the login throttle.

In public mode:
- cookies are always `Secure`, and HSTS is sent;
- repeated failed logins slow down globally;
- API tokens are off unless enabled.

Caddy example:

```
wickline.example.com {
  reverse_proxy unraid:5173
}
```

## Security model

- **Login covers everything** except `/api/health/ready`, the container healthcheck, which returns only `{"ok":true}`. That includes the app, its market-data API, and upstream's `/api/health`.
- **Failed logins** get an increasing delay per client, never a lockout. In public mode a short global spacing is added.
- **Cross-site requests:** every state-changing request must carry a same-origin `Origin` header, and session cookies are `HttpOnly; SameSite=Lax`. Changes through the self-hosting JSON API also need an `X-Wickline-Selfhost: 1` header.
- **Slow clients:** a request must arrive within 60 seconds. Long-lived streams are not affected.
- **Upstream's `Access-Control-Allow-Origin: *`** is removed, so other sites cannot read the API.
- **Stored secrets:** sessions and API tokens are kept as SHA-256 digests, the password as scrypt. TOTP codes cannot be reused.
- **Audit log:** logins, failures, logouts and API token use (at most hourly per token) are recorded in the database.
- **Content security policy:** sent in report-only mode.

## Administration

Run these inside the container (`docker exec -it wickline …`):

```sh
node selfhost/cli.mjs hash-password          # new password hash
node selfhost/cli.mjs totp-setup [label]     # new TOTP secret + otpauth:// URI
node selfhost/cli.mjs token create <label>   # API token for scripts (shown once)
node selfhost/cli.mjs token list | token revoke <id>
node selfhost/cli.mjs sessions revoke-all    # sign out every browser
```

Use API tokens as `Authorization: Bearer wl_…`.

## Backup, upgrade and restore

See [UPGRADE.md](UPGRADE.md). In short: everything lives in the `/data` volume (`wickline.db`). Schema migrations write a backup to `/data/backups/` before they run.

## Known limitations

- Single user.
- Cross-device sync is being built (Phase 2): the server stores synced state, and the browser side follows. Server-side alerts arrive in Phase 3. Until then, user data stays in each browser, as upstream.
- The content security policy is report-only, because upstream relies on an inline script and `unsafe-eval` in its script sandbox.

## Licence

MIT, as upstream. The image keeps the copyright notices of Wickline contributors and of TradingView Lightweight Charts™ (Apache-2.0).
