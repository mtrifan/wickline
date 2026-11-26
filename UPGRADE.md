# Upgrading, rolling back, backup and restore

> The upgrade and rollback steps below are exercised on every pull request by `selfhost/test/docker/upgrade.sh`. It runs a release, upgrades it with an image that adds a schema migration, checks that a downgrade is refused, then rolls back with the pre-migration backup.

## Image tags

| Tag | Meaning | Use it when |
|---|---|---|
| `X.Y.Z-sh.N` | Immutable self-hosted release N on upstream X.Y.Z | You want to pin exactly (recommended) |
| `X.Y.Z` | Latest self-hosted revision on upstream X.Y.Z | You want fixes, not new upstream versions |
| `stable` / `latest` | Newest validated and approved release | You want automatic upgrades |
| `edge` | Every change on the production branch | Testing only |

## Upgrade

1. Read `CHANGELOG-SELFHOSTED.md` for the target release.
2. Pull the new tag and recreate the container. Data in `/data` is kept.
3. On start, any database migration runs automatically. A backup is written first: `/data/backups/pre-migrate-<from>-<to>-<time>.db`.

On Unraid: edit the container, set the image tag (for example `ghcr.io/mtrifan/wickline:0.1.9-sh.2`, or keep `:stable` and use **Force update**), and apply.

## Roll back

1. Stop the container.
2. Pin the previous immutable tag.
3. If the newer version migrated the database, the older version refuses to start (exit code 78) and says so. Restore the pre-migration backup:
   `docker run --rm -v <appdata>:/data <image:previous-tag> node selfhost/cli.mjs restore /data/backups/pre-migrate-….db`
4. Start the container. Open browsers show "The server's data was restored or imported" and reload into it. Everyone signs in again; API tokens keep working.

Data written after the upgrade is not in the pre-migration backup. Export it first (`/api/selfhost/export`) if you need it, and import it after the rollback if the older version understands it.

## Backup

- **Automatic:** a backup is written to `/data/backups/wickline-<time>.db` every 24 hours (`BACKUP_INTERVAL_HOURS`, `0` turns it off), and the newest 14 are kept (`BACKUP_KEEP`). Backups made before a migration or a restore (`pre-migrate-…`, `pre-restore-…`) are never pruned. Delete them yourself when no longer needed.
- **Now:** `docker exec wickline node selfhost/cli.mjs backup`.
- **Download:** while signed in, open `/api/selfhost/backup` to save the whole database (a consistent copy, safe while the app runs).
- **Portable export:** open `/api/selfhost/export` for a JSON file with your synced data: watchlist, drawings, scripts, alerts, paper account, layout and settings. Sessions, API tokens and the audit log are not included.

Back up the `/data` folder with your usual tools too; the backups live inside it.

## Restore a backup

1. Stop the container. The restore refuses to run while the server is up.
2. Run the restore with the same image and data folder:
   `docker run --rm -v <appdata>:/data <image> node selfhost/cli.mjs restore /data/backups/wickline-<time>.db`
   It checks the file's integrity and schema version, saves the current database as `/data/backups/pre-restore-<time>.db`, then swaps the backup in. Logins never go back in time: every browser signs in again (with two-factor login, use the next code), and API tokens are carried over from the database being replaced, so a token revoked after the backup stays revoked. Restoring into an empty data folder keeps the backup's tokens instead.
   If the current database is damaged, its raw file is kept as `pre-restore-<time>-raw.db` and the restore goes ahead. Which tokens were revoked cannot be read from a damaged file, so all API tokens are removed; create new ones with `cli.mjs token create`.
3. Start the container. Open browsers show "The server's data was restored or imported" and reload into it. A browser with changes newer than the backup offers them as a download.

If the server stopped uncleanly, the restore may report it as running for up to 90 seconds. Wait, or add `--force` once you are sure it is stopped.

## Import a JSON export

An import **replaces** all synced data with the file's contents; everything else (login, tokens) is unchanged. Every open browser reloads into the imported data. Keys this server keeps on each device (the chart layout with `SYNC_WORKSPACE=false`) are skipped and listed in the response. With an API token (`cli.mjs token create import`):

```sh
curl -X POST https://<your-host>/api/selfhost/import \
  -H "Authorization: Bearer <token>" -H "X-Wickline-Selfhost: 1" \
  -H "Content-Type: application/json" --data-binary @wickline-export-<time>.json
```

The "Download previous data" file a browser offers after a restore is a record of that browser's old values (`"app": "wickline"`), not an export, so it cannot be imported.
