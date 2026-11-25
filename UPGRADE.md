# Upgrading, rolling back, backup and restore

> Backup, restore and migrations work today. Release tags and the upgrade flow arrive with the first release (Phase 4; see [the plan](selfhost/docs/PLAN.md) §5.4).

## Image tags

| Tag | Meaning | Use it when |
|---|---|---|
| `X.Y.Z-sh.N` | Immutable self-hosted release N on upstream X.Y.Z | You want to pin exactly (recommended) |
| `X.Y.Z` | Latest self-hosted revision on upstream X.Y.Z | You want fixes, not new upstream versions |
| `stable` / `latest` | Newest validated and approved release | You want automatic upgrades |
| `edge` | Every change on the production branch | Testing only |

## Upgrade (planned)

1. Read `CHANGELOG-SELFHOSTED.md` for the target release.
2. Pull the new tag and recreate the container. Data in `/data` is kept.
3. On start, any database migration runs automatically. A backup is written first: `/data/backups/pre-migrate-<from>-<to>-<time>.db`.

## Roll back (planned)

1. Stop the container.
2. Pin the previous immutable tag.
3. If the newer version migrated the database, the older version refuses to start and says so. Restore the pre-migration backup:
   `docker run --rm -v <appdata>:/data <image:previous-tag> node selfhost/cli.mjs restore /data/backups/pre-migrate-….db`
4. Start the container. Open browsers show "The server's data was restored or imported" and reload into it.

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
   It checks the file's integrity and schema version, saves the current database as `/data/backups/pre-restore-<time>.db`, then swaps the backup in. Logins never go back in time: every browser signs in again, API tokens stay as they are now (a token revoked after the backup stays revoked), and used two-factor codes stay used.
3. Start the container. Open browsers show "The server's data was restored or imported" and reload into it. A browser with changes newer than the backup offers them as a download.

If the server stopped uncleanly, the restore may report it as running for up to 90 seconds. Wait, or add `--force` once you are sure it is stopped.

## Import a JSON export

An import **replaces** all synced data with the file's contents; everything else (login, tokens) is unchanged. Every open browser reloads into the imported data. With an API token (`cli.mjs token create import`):

```sh
curl -X POST https://<your-host>/api/selfhost/import \
  -H "Authorization: Bearer <token>" -H "X-Wickline-Selfhost: 1" \
  -H "Content-Type: application/json" --data-binary @wickline-export-<time>.json
```
