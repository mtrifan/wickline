# Upgrading, rolling back, backup and restore

> Filled in as the container ships (Phases 1–4). The procedures below are the agreed design (see [the plan](selfhost/docs/PLAN.md) §2.4 and §5.4); commands will be finalised and tested in CI before the first release.

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
4. Start the container. Open browsers re-sync to the restored data automatically (restore epoch).

## Backup and restore (planned)

- Automatic daily backups go to `/data/backups/`, 14 kept by default.
- An on-demand download of the database, or a portable JSON export, is available from the settings page.
- Restore with the container stopped, using the `restore` command above.
