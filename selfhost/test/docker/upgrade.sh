#!/usr/bin/env bash
# Upgrade and rollback test (PLAN §7 Phase 4, UPGRADE.md "Upgrade" and "Roll back"), with real
# containers on one data volume:
#   1. release N (the image under test) runs and stores data;
#   2. "release N+1" (the same image plus a test migration) upgrades it: the data survives and a
#      pre-migration backup is written;
#   3. rolling back to release N is refused (exit 78) while the database is newer;
#   4. the documented rollback restores the pre-migration backup with release N, which then starts
#      with the data intact.
#
#   IMAGE=wickline-selfhost:dev selfhost/test/docker/upgrade.sh      (builds the image if IMAGE is unset)
set -euo pipefail

cd "$(dirname "$0")/../../.."
IMAGE="${IMAGE:-}"
NEXT="wickline-selfhost:upgrade-next-$$"
NAME="wl-upgrade-$$"
VOL="wl-upgrade-data-$$"
PORT="${UPGRADE_PORT:-15174}"
BASE="http://127.0.0.1:${PORT}"
PASSWORD='correct horse battery staple'
JAR="$(mktemp)"
CTX="$(mktemp -d)"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -n 30 >&2 || true; exit 1; }
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
  docker image rm -f "$NEXT" >/dev/null 2>&1 || true
  rm -rf "$JAR" "$CTX"
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  IMAGE=wickline-selfhost:upgrade
  docker build -q -f selfhost/Dockerfile -t "$IMAGE" . >/dev/null
fi

# "Release N+1": one more migration on top of the image under test.
known=$(docker run --rm "$IMAGE" node -e "import('./selfhost/storage/db.mjs').then((m) => console.log(m.loadMigrations().length))")
next=$((known + 1))
printf -- "-- Test-only migration (upgrade.sh): a schema change between two releases.\nCREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY, note TEXT);\nINSERT INTO upgrade_probe (note) VALUES ('from release N+1');\n" > "$CTX/$(printf '%03d' "$next")_upgrade_probe.sql"
printf 'FROM %s\nCOPY *.sql /app/selfhost/storage/migrations/\n' "$IMAGE" > "$CTX/Dockerfile"
docker build -q -t "$NEXT" "$CTX" >/dev/null

start() { # image
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:5173" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -v "$VOL:/data" -e WICKLINE_PASSWORD="$PASSWORD" "$1" >/dev/null
  for _ in $(seq 1 60); do
    curl -fsS "$BASE/api/health/ready" >/dev/null 2>&1 && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || fail "container exited"
    sleep 1
  done
  fail "not ready within 60 s"
}
stop() { docker stop -t 10 "$NAME" >/dev/null; docker rm "$NAME" >/dev/null; }
login() {
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H "Origin: $BASE" --data-urlencode "password=$PASSWORD" -d next=/ "$BASE/selfhost/login")"
  case "$code" in 302|303) ;; *) fail "login returned $code" ;; esac
}
schema() { docker run --rm -v "$VOL:/data" "$IMAGE" node -e "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync('/data/wickline.db', { readOnly: true }).prepare('PRAGMA user_version').get().user_version)" 2>/dev/null; }
state() { curl -fsS -b "$JAR" "$BASE/api/selfhost/state"; }
epoch_of() { sed -E 's/.*"epoch":"([0-9a-f]+)".*/\1/'; }
has_table() { docker run --rm -v "$VOL:/data" "$IMAGE" node -e "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync('/data/wickline.db', { readOnly: true }).prepare(\"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '$1'\").get().n)" 2>/dev/null; }

echo "== release N (schema $known) stores data"
start "$IMAGE"
login
epoch="$(state | sed -E 's/.*"epoch":"([0-9a-f]+)".*/\1/')"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT -H "Origin: $BASE" -H 'X-Wickline-Selfhost: 1' -H 'Content-Type: application/json' \
  --data "{\"value\":\"\\\"dark\\\"\",\"baseVersion\":0,\"epoch\":\"$epoch\"}" "$BASE/api/selfhost/state/theme")"
[ "$code" = 200 ] || fail "synced write returned $code"
token="$(docker exec "$NAME" node selfhost/cli.mjs token create upgrade-test | grep -o 'wl_[A-Za-z0-9_-]*' | head -n 1)"
[ -n "$token" ] || fail "no API token created"
stop
echo "ok: synced value and API token stored"

echo "== release N+1 upgrades the database to schema $next"
start "$NEXT"
logs="$(docker logs "$NAME" 2>&1)"
grep -q "database migration applied" <<<"$logs" || fail "no migration logged"
grep -q '"theme":{"v":"\\"dark\\""' <<<"$(curl -fsS -H "Authorization: Bearer $token" "$BASE/api/selfhost/state")" || fail "synced value lost in the upgrade"
backup="$(docker exec "$NAME" sh -c "ls -1 /data/backups/pre-migrate-${known}-to-${next}-*.db" | head -n 1)"
[ -n "$backup" ] || fail "no pre-migration backup"
# A change after the upgrade: the rollback must bring back the value from before it.
upgraded="$(curl -fsS -H "Authorization: Bearer $token" "$BASE/api/selfhost/state")"
up_epoch="$(epoch_of <<<"$upgraded")"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -X PUT -H 'X-Wickline-Selfhost: 1' -H 'Content-Type: application/json' \
  --data "{\"value\":\"\\\"light\\\"\",\"baseVersion\":1,\"epoch\":\"$up_epoch\"}" "$BASE/api/selfhost/state/theme")"
[ "$code" = 200 ] || fail "write after the upgrade returned $code"
grep -q '"theme":{"v":"\\"light\\""' <<<"$(curl -fsS -H "Authorization: Bearer $token" "$BASE/api/selfhost/state")" || fail "the write after the upgrade did not take"
stop
[ "$(has_table upgrade_probe)" = 1 ] || fail "the test migration's table is missing after the upgrade"
[ "$(schema)" = "$next" ] || fail "schema is not $next after the upgrade"
echo "ok: data kept, API token works, $backup written"

echo "== rolling back to release N"
# Detached with a deadline: a release that wrongly accepted the newer database would keep running.
docker run -d --name "$NAME" -v "$VOL:/data" -e WICKLINE_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break; sleep 1; done
[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] || fail "release N started on a newer database"
code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
grep -q "Roll back" <<<"$(docker logs "$NAME" 2>&1)" || fail "the refusal does not point to the rollback steps"
docker rm "$NAME" >/dev/null
[ "$code" = 78 ] || fail "release N exited with $code on a newer database (expected 78)"
echo "ok: refused with exit code 78 and a pointer to the rollback steps"
out="$(docker run --rm -v "$VOL:/data" "$IMAGE" node selfhost/cli.mjs restore "$backup")" || fail "restore failed: $out"
start "$IMAGE"
restored="$(curl -fsS -H "Authorization: Bearer $token" "$BASE/api/selfhost/state")"
grep -q '"theme":{"v":"\\"dark\\""' <<<"$restored" || fail "the rollback did not bring back the value from before the upgrade"
[ "$(epoch_of <<<"$restored")" != "$up_epoch" ] || fail "the rollback kept the epoch, so open browsers would not reload"
stop
[ "$(schema)" = "$known" ] || fail "schema is not $known after the rollback"
[ "$(has_table upgrade_probe)" = 0 ] || fail "the upgraded database is still in place after the rollback"
echo "ok: release N runs again on schema $known with the pre-upgrade data, a new epoch and the API token"
echo PASS
