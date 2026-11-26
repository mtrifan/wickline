# Wickline Self-Hosted

An unofficial, self-hosted edition of [Wickline](https://github.com/keptaduona/wickline) that runs 24/7 in Docker, for example on Unraid. It runs the unmodified upstream app and adds:

- **single-user login**: password, optional two-factor (TOTP), sessions that survive restarts;
- **sync across devices**: watchlists, layouts, drawings, custom indicators, alerts and preferences, with daily backups;
- **background price alerts** checked on the server around the clock (Yahoo, Binance, Coinbase), with one Gotify push notification per alert, even with no browser open.

> **Status:** login, sync, backups and server-side alerts are complete and in daily use. The current release is **0.1.9-sh.1**: use `ghcr.io/mtrifan/wickline:stable` (follows approved releases) or pin `:0.1.9-sh.1`. `:edge` follows every change and is for testing. See [UPGRADE.md](UPGRADE.md) for tags, upgrades and rollback.

## Install

You need a **password hash**, not the password itself. Run this anywhere Docker is available, type the password twice (12+ characters), and copy the output, which starts with `scrypt$`:

```sh
docker run --rm -it ghcr.io/mtrifan/wickline:stable node selfhost/cli.mjs hash-password
```

### Unraid

1. **Add the template.** Unraid's Template field is a list, not a text box, so copy the template onto the flash drive. In the Unraid terminal (`>_`, top right):
   ```sh
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   wget -O /boot/config/plugins/dockerMan/templates-user/my-wickline.xml \
     https://raw.githubusercontent.com/mtrifan/wickline/selfhosted/selfhost/unraid/wickline.xml
   ```
2. **Pick it.** Docker → Add Container, reload the page, and choose **wickline** under *User templates* in the Template list.
3. **Fill in the fields** (more under *Show more settings*):
   - **Password hash:** the `scrypt$…` output from above.
   - **Data:** `/mnt/user/appdata/wickline`. The default owner `nobody:users` (99:100) is what the container runs as.
   - **Exposure:** `private` for LAN/Tailscale.
   - For push notifications: **Gotify URL**, **Gotify app token** and **Public URL** (see [Notifications](#notifications)).
4. **Apply,** then open the WebUI (`http://<unraid-ip>:5173`).

To update, click the container's icon → **Force update** (or use the update the Docker tab offers). Your data in `/mnt/user/appdata/wickline` is kept.

Installed before the first release? Your container still uses `:edge`. Click its icon → **Edit**, change **Repository** to `ghcr.io/mtrifan/wickline:stable`, and **Apply**. Your settings and data stay.

**Do not run the `wget` command again after installing.** Unraid saves your values (password hash, TOTP secret, Gotify token) in that same `my-wickline.xml`, so downloading over it wipes them. When a release adds a setting you want, open the container's **Edit** page and use *Add another Path, Port, Variable, Label or Device* to add it by name (the variables are listed under [Configuration](#configuration)).

### Docker Compose

```sh
mkdir -p wickline/data wickline/secrets && cd wickline
sudo chown 99:100 data                     # the container runs as UID 99
curl -fsSLO https://raw.githubusercontent.com/mtrifan/wickline/selfhosted/selfhost/docker-compose.yml
docker run --rm -it ghcr.io/mtrifan/wickline:stable node selfhost/cli.mjs hash-password > secrets/password_hash
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
  ghcr.io/mtrifan/wickline:stable
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
| `BACKUP_INTERVAL_HOURS` | `24` | Hours between automatic backups to `/data/backups/`. `0` turns them off. |
| `BACKUP_KEEP` | `14` | How many automatic backups are kept. |
| `GOTIFY_URL` | none | Your Gotify server, e.g. `http://192.168.1.10:8070` or `https://gotify.example.com`. Wickline connects to it directly, never through `WICKLINE_PROXY`. |
| `GOTIFY_TOKEN` | none | The token of a Gotify **application** created for Wickline (also `GOTIFY_TOKEN_FILE`). It never reaches the browser. |
| `GOTIFY_PRIORITY` | `8` | Gotify priority, 0-10. Android shows 8 and above as a heads-up notification. |
| `PUBLIC_URL` | none | How you reach Wickline from your phone, e.g. `http://192.168.1.10:5173`, `http://wickline.home.lan:5173` (a local DNS name or CNAME; keep the port) or `https://wickline.example.com` behind a proxy. Tapping a notification opens this address; Wickline never connects to it, but your phone must be able to resolve and reach it. |
| `NOTIFY_MAX_ATTEMPTS` | `8` | Attempts per notification before giving up (retries back off from 5 s to 30 min). |
| `ALERTS_SERVER` | `true` | Check alerts on the server, with no browser open. `false` leaves alerts to open browser tabs (their triggers are still pushed). |
| `ALERT_EXTENDED_HOURS` | `true` | Also check pre-market and after-hours prices. Each session is compared only with itself, so the jump from one session to the next never counts as a crossing. |
| `ALERT_RESUME_MAX_GAP` | `15` | Minutes. After a restart within this time, the last price seen before it is kept, so a crossing during the downtime fires once (the notification says so). After a longer gap the first price is only a starting point. |
| `ALERT_MAX_SYMBOLS` | `200` | Most symbols with armed alerts checked on the server. Beyond it, some are left to the browser and a warning is logged. |
| `ALERT_POLL_INTERVAL` | `30` | Seconds between fallback price requests for a symbol whose live stream has gone quiet while its market is open (minimum 10). |
| `ALERT_CLOSED_POLL_INTERVAL` | `900` | Seconds between checks of whether a closed market has reopened. |
| `ALERT_STALE_AFTER` | 5 crypto, 10 others | Minutes without a live price, while the market is open, before the fallback starts. Setting it applies one value to every symbol. |
| `PAPER_SERVER` | `true` | Fill the live paper account's limit and stop orders, stop losses and take profits on the server while no Wickline window is open (best effort; see [Paper trading](#paper-trading)). |
| `NOTIFY_PAPER` | `true` | Push a notification for each paper fill or rejection the server makes. |
| `NOTIFY_STALE` | `false` | Also send a notification when a symbol gets no prices at all (stream and fallback) while its market is open. One per episode. |
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

#### Behind a reverse proxy you already run (Nginx Proxy Manager, Caddy, SWAG)

If your router already forwards 443 to a reverse proxy on Unraid with a Let's Encrypt certificate:

1. **DNS.** Point `wickline.yourdomain.com` at your home address, like your other services: a CNAME to your dynamic-DNS name, or an A record.
2. **Proxy host.** Forward `wickline.yourdomain.com` to `http://<unraid-ip>:5173`, or to `http://wickline:5173` if both containers share a Docker network. Use HTTPS with your certificate, force SSL, and allow WebSockets.
   - **Nginx Proxy Manager:** the steps above are the defaults. Wickline marks its live streams as not to be buffered, so no custom configuration is needed. If live prices still arrive in bursts, add `proxy_buffering off;` under *Advanced*.
   - **Caddy:**
     ```
     wickline.yourdomain.com {
       reverse_proxy <unraid-ip>:5173
     }
     ```
3. **Find the proxy's address as Wickline sees it.** Open `https://wickline.yourdomain.com` and sign in, then run `docker logs wickline 2>&1 | grep '"msg":"login"' | tail -n 1`. While `TRUST_PROXY` is off, the `ip` shown is the proxy's address, for example `172.17.0.1` or `172.18.0.5`.
4. **Two-factor login.** Run `docker exec -it wickline node selfhost/cli.mjs totp-setup` and add the code to an authenticator app.
5. **Settings.** Edit the container:
   - `EXPOSURE=public`;
   - `WICKLINE_PASSWORD_HASH` (keep yours);
   - `WICKLINE_TOTP_SECRET` from step 4;
   - `TRUST_PROXY=true`;
   - `TRUSTED_PROXY_IPS` set to the address from step 3;
   - `PUBLIC_URL=https://wickline.yourdomain.com`, so notification links work away from home.
6. **Close the direct port.** Do not forward 5173 on your router. Public mode refuses plain-HTTP requests, so `http://<unraid-ip>:5173` stops working even at home: use the domain there too. That needs your router to support hairpin NAT, or local DNS pointing the name at the proxy. A proxy on a shared Docker network can reach Wickline without the port published at all.

## Sync between devices

Your watchlist, drawings, scripts, alerts, paper account, chart layout and display settings are stored on the server and shared by every browser you sign in from. Device-specific items stay in each browser: your Twelve Data key, panel heights, the open side tab and similar UI state.

- **Live updates:** alerts, the paper account, scripts and the language change on other devices within a few seconds.
- **Everything else** (watchlist, drawings, layout, theme) needs a reload to show. A banner says "Updated on another device" with a **Reload** button. A tab in the background reloads by itself when you return to it, never while hidden.
- **Conflicts:** if two devices change the same watchlist, drawing, layout or paper account, the first change to reach the server wins, and the other device shows "Your change on this device was replaced by a newer one". Scripts and alerts are merged entry by entry, so additions from both devices are kept. A deleted alert stays deleted for 30 days, even if a device that was offline still has it. Whether an alert has fired is decided by the server: a device that did not see an alert fire cannot re-arm it, and a device offline long enough to miss 20 changes to your alerts reloads them from the server instead of merging: alert changes made on that device while it was offline are discarded, and it shows "Your change on this device was replaced by a newer one".
- **Offline:** changes are kept in the browser and sent when the server is reachable again. The dot in the bottom-right corner shows the state: green means synced, amber means saving, red means offline.
- **Existing browser data:** the first time a browser that already holds Wickline data connects, the server's data wins. A banner offers a download of the browser's previous data. Items the server does not have yet are uploaded.
- **Limits:** synced data is capped at 10 million characters in total. A browser holds about half of that, so this cap only stops runaway clients.

## Notifications

Wickline sends push notifications through [Gotify](https://gotify.net), a self-hosted push server with an Android app.

1. In Gotify, create an **application** (Apps → Create application) named Wickline, and copy its token.
2. Set `GOTIFY_URL` and `GOTIFY_TOKEN`, and `PUBLIC_URL` so that tapping a notification opens Wickline.
3. Send a test: `docker exec wickline node selfhost/cli.mjs notify-test`. It prints the exact error if delivery fails (for example "Gotify answered 401 (Unauthorized: …)" for a wrong token). While signed in, `/api/selfhost/notify/status` shows whether a provider is configured and how the last queued notification went (test messages are not counted there).

Notifications are queued in the database and survive restarts. When Gotify is unreachable or answers with a server error, they are retried with increasing delays (5 s up to 30 min) for up to `NOTIFY_MAX_ATTEMPTS` attempts. After that, or straight away when Gotify refuses a message (a wrong token, a redirect), the notification is dropped and the error is logged and shown in the status. Delivery is at-least-once: if the container stops in the instant between Gotify accepting a message and Wickline recording it, that one message can arrive twice.

Run only one container on a data folder: a second one refuses to start while the first is running. After an unclean stop (a crash, a power cut) a replacement container may be refused for up to 90 seconds; the same container restarting is never refused.

When an alert fires in an open Wickline tab, the server sends one notification for it: a second device that saw the same crossing, or a retried request, does not send another. An alert that fired on a device while it was offline is pushed when the device reconnects, if that was within the last 15 minutes. The notification shows the alert ("BTCUSDT crossing up 100000") and the price at that moment, plus your note. 

The server also checks alerts itself, with no browser open, using the same live prices the app shows: Yahoo (stocks, ETFs, indices, futures, forex), Binance, Bybit and OKX (spot and perpetuals), and Coinbase. It follows the app's rules: "crossing up" fires when the price goes from below the level to at or above it, and the first price after you arm an alert is only a starting point. Whichever side sees a crossing first, the server or a browser, records it; the notification is sent once. While signed in, `/api/selfhost/alerts/status` shows whether the checker is running, how many symbols it watches, and the state of each symbol:

- **live:** prices are streaming.
- **closed:** the market is closed (no trades in the last 15 minutes: nights, weekends, holidays). Quiet is expected, and nothing is requested until it reopens.
- **fallback:** the stream went quiet while the market is open, so the price is requested every `ALERT_POLL_INTERVAL` seconds instead and alerts keep working. For Yahoo symbols the fallback gets the regular-session price, so during pre-market and after-hours a stream outage pauses extended-hours checks until the stream returns.
- **stale:** the fallback failed too, so there is no price at all. Its alerts cannot fire until prices return; `NOTIFY_STALE=true` sends a notification when this starts (at most one per symbol per hour).

Crypto markets are always open. When Binance answers "too many requests", the fallback waits as long as Binance asks. Connections to the exchanges go through `WICKLINE_PROXY` when it is set.

Like an app tab left open overnight, the checker compares the first regular-session price of the day with the previous close, so a level crossed between the close and the open fires at the open. If the checker stops, it is restarted automatically; `/api/health/ready` reports only the web server and database, so the checker restarting never marks the container unhealthy.

## Paper trading

Your paper account (cash, positions, orders, history, settings) is stored on the server and shared by all your devices, like the rest of your data, and it is in every backup.

**While a Wickline window is open**, the app fills paper orders itself, exactly as upstream does.

**While no window is open** (every tab closed, or the phone asleep), the server takes over after 2.5 minutes:
- it fills limit and stop orders, stop losses and take profits at upstream's rules, using live streamed prices;
- each fill or rejection is pushed ("AAPL stop loss filled at 189.50");
- when you open Wickline again, the server stops first and the app starts from the account as it is now, including what filled while you were away.

Each open main window tells the server it is there every 30 seconds; pop-out windows do not fill orders and do not count. `/api/selfhost/alerts/status` shows who fills now (`paper.owner`), the watched symbols, and the last server fill. `PAPER_SERVER=false` turns this off.

This is **best effort**. Upstream's app fills and saves on its own, and the fork does not change upstream's code, so a few edge cases remain:
- For up to 2.5 minutes after the last window closes or the device sleeps, nobody fills. A price that crosses your level and comes back in that time is missed. So is any move while the server was down or the price stream was out.
- A tab that wakes after the server took over may act briefly on its old copy. Usually it then shows "Your change on this device was replaced by a newer one" and reloads. A change made in the split second before an update arrives can be lost without a notice.
- A change that never reached the server, such as cancelling an order just before closing the tab on a bad connection, is not known to the server, which can still fill that order.
- Server fills use streamed prices only, not the REST fallback, which can be delayed. A symbol whose stream is quiet is not filled until prices return.

## Security model

- **Login covers everything** except `/api/health/ready`, the container healthcheck, which returns only `{"ok":true}`. That includes the app, its market-data API, and upstream's `/api/health`.
- **The alert checker's access:** the server-side alert checker reads market data through a second listener bound to `127.0.0.1` on a random port inside the container, never exposed. It answers only three read-only market-data routes, and only with a random credential created at each start that never leaves the process.
- **Failed logins** get an increasing delay per client, never a lockout. In public mode a short global spacing is added.
- **Cross-site requests:** every state-changing request from a browser must carry a same-origin `Origin` header, and session cookies are `HttpOnly; SameSite=Lax`. Changes through the self-hosting JSON API also need an `X-Wickline-Selfhost: 1` header. Requests with an API token (`Authorization: Bearer`) need no `Origin`: browsers never send these tokens on their own.
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
node selfhost/cli.mjs backup                 # write a backup to /data/backups now
node selfhost/cli.mjs notify-test            # send a test notification
```

`node selfhost/cli.mjs restore <file>` replaces the database with a backup. It runs with the container **stopped**; see [UPGRADE.md](UPGRADE.md#restore-a-backup).

Use API tokens as `Authorization: Bearer wl_…`.

## Backup, upgrade and restore

See [UPGRADE.md](UPGRADE.md). In short: everything lives in the `/data` volume (`wickline.db`). A backup is written to `/data/backups/` every day and before every schema migration. While signed in, `/api/selfhost/backup` downloads the database and `/api/selfhost/export` your synced data as JSON. `node selfhost/cli.mjs restore <file>` restores a backup with the container stopped.

## Known limitations

- Single user.
- A market counts as open while its symbol trades: a symbol with no trade for 15 minutes during the session counts as closed until it trades again, so a very thinly traded stock can be checked less often.
- The content security policy is report-only, because upstream relies on an inline script and `unsafe-eval` in its script sandbox.

## Licence

MIT, as upstream. The image keeps the copyright notices of Wickline contributors and of TradingView Lightweight Charts™ (Apache-2.0).
