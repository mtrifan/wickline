#!/usr/bin/env bash
# Container smoke test: runs the image hardened (read-only root, no capabilities), then checks
# health, login, non-root user, the injected sync agent, synced state, graceful stop with an open
# stream, persistence across restarts, the server lock, backups, and a restore (container stopped).
#
#   IMAGE=wickline-selfhost:dev selfhost/test/docker/smoke.sh      (builds the image if IMAGE is unset)
set -euo pipefail

cd "$(dirname "$0")/../../.."
IMAGE="${IMAGE:-}"
NAME="wl-smoke-$$"
VOL="wl-smoke-data-$$"
PORT="${SMOKE_PORT:-15173}"
BASE="http://127.0.0.1:${PORT}"
PASSWORD='correct horse battery staple'
JAR="$(mktemp)"
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>&1 | tail -n 40 >&2 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$VOL" >/dev/null 2>&1 || true; rm -f "$JAR"; [ -n "${SSE_PID:-}" ] && kill "$SSE_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  IMAGE=wickline-selfhost:smoke
  docker build -q -f selfhost/Dockerfile -t "$IMAGE" . >/dev/null
fi

run() {
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:5173" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -v "$VOL:/data" -e WICKLINE_PASSWORD="$PASSWORD" -e LOG_LEVEL=info "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
    [ "$status" = healthy ] && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || fail "container exited"
    # Faster than the 30 s healthcheck interval: probe readiness directly too.
    curl -fsS "$BASE/api/health/ready" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "not healthy within 60 s (last status: $status)"
}

echo "== start"
run
wait_healthy
echo "ok: ready"

[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "runs as root"
echo "ok: uid $(docker exec "$NAME" id -u)"

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
[ "$code" = 401 ] || fail "unauthenticated /api/health returned $code"
echo "ok: API requires login"

code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H "Origin: $BASE" --data-urlencode "password=$PASSWORD" -d next=/ "$BASE/selfhost/login")"
[ "$code" = 302 ] || fail "login returned $code"
grep -q '"app":"wickline"' <<<"$(curl -fsS -b "$JAR" "$BASE/api/health")" || fail "authenticated /api/health"
grep -q '<title>Wickline</title>' <<<"$(curl -fsS -b "$JAR" "$BASE/")" || fail "app page"
if grep -qi '^access-control-allow-origin' <<<"$(curl -sS -D - -o /dev/null -b "$JAR" "$BASE/api/health")"; then fail "CORS header leaked"; fi
echo "ok: login, app and API"

echo "== sync"
page="$(curl -fsS -b "$JAR" "$BASE/")"
grep -q 'id="wl-snapshot"' <<<"$page" || fail "snapshot not injected"
grep -q 'src="/selfhost/boot.js"' <<<"$page" || fail "boot.js not injected"
grep -q 'wickline-selfhost' <<<"$(curl -fsS -b "$JAR" "$BASE/selfhost/boot.js")" || fail "boot.js not served"
EPOCH="$(curl -fsS -b "$JAR" "$BASE/api/selfhost/state" | sed -E 's/.*"epoch":"([0-9a-f]+)".*/\1/')"
[ -n "$EPOCH" ] || fail "no epoch in the snapshot"
put() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT -H "Origin: $BASE" -H 'X-Wickline-Selfhost: 1' -H 'Content-Type: application/json' \
  --data "{\"value\":\"$2\",\"baseVersion\":$3,\"epoch\":\"$EPOCH\"}" "$BASE/api/selfhost/state/$1"; }
code="$(put theme light 0)"; [ "$code" = 200 ] || fail "sync write returned $code"
docker exec "$NAME" sh -c 'test -f /data/server.lock' || fail "no server lock while running"
echo "ok: snapshot and boot.js injected, synced write accepted, server lock held"

echo "== server-side alerts"
st="$(curl -fsS -b "$JAR" "$BASE/api/selfhost/alerts/status")"
grep -q '"enabled":true' <<<"$st" || fail "alert checker not enabled: $st"
grep -q '"running":true' <<<"$st" || fail "alert worker not running: $st"
echo "ok: alert worker thread running"

echo "== backup inside the container"
out="$(docker exec "$NAME" node selfhost/cli.mjs backup)" || fail "cli backup: $out"
grep -q 'backup written: /data/backups/wickline-' <<<"$out" || fail "unexpected backup output: $out"
BACKUP="$(docker exec "$NAME" sh -c 'ls -1 /data/backups/wickline-*.db | tail -n 1')"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/selfhost/backup")"; [ "$code" = 200 ] || fail "backup download returned $code"
grep -q '"theme":"light"' <<<"$(curl -fsS -b "$JAR" "$BASE/api/selfhost/export")" || fail "export misses the synced key"
docker exec "$NAME" node selfhost/cli.mjs restore "$BACKUP" >/dev/null 2>&1 && fail "restore ran while the server was up"
echo "ok: backup written ($BACKUP), download and export work, restore refused while running"
code="$(put theme dark 1)"; [ "$code" = 200 ] || fail "second sync write returned $code"

echo "== graceful stop with an open stream"
curl -sN -b "$JAR" "$BASE/api/yahoo/stream?symbols=" >/dev/null 2>&1 & SSE_PID=$!
sleep 1
start=$(date +%s)
docker stop -t 15 "$NAME" >/dev/null
took=$(( $(date +%s) - start ))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$exit_code" = 0 ] || fail "exit code $exit_code after SIGTERM"
[ "$took" -le 10 ] || fail "stop took ${took}s"
echo "ok: stopped in ${took}s with exit code 0"

echo "== restart keeps data"
docker start "$NAME" >/dev/null
wait_healthy
grep -q '"app":"wickline"' <<<"$(curl -fsS -b "$JAR" "$BASE/api/health")" || fail "session lost after restart"
docker exec "$NAME" sh -c 'test -s /data/wickline.db' || fail "database missing in /data"
grep -q '"theme":{"v":"dark"' <<<"$(curl -fsS -b "$JAR" "$BASE/api/selfhost/state")" || fail "synced state lost after restart"
echo "ok: session, database and synced state survived the restart"

echo "== restore with the container stopped"
docker stop -t 15 "$NAME" >/dev/null
docker run --rm -v "$VOL:/data" "$IMAGE" sh -c 'test ! -e /data/server.lock' || fail "lock left after a clean stop"
out="$(docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -v "$VOL:/data" "$IMAGE" \
  node selfhost/cli.mjs restore "$BACKUP")" || fail "restore with the container stopped: $out"
grep -q '^restored ' <<<"$out" || fail "unexpected restore output: $out"
docker start "$NAME" >/dev/null
wait_healthy
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/selfhost/state")"
[ "$code" = 401 ] || fail "the session survived a restore (got $code)"
curl -s -o /dev/null -c "$JAR" -H "Origin: $BASE" --data-urlencode "password=$PASSWORD" -d next=/ "$BASE/selfhost/login"
snap="$(curl -fsS -b "$JAR" "$BASE/api/selfhost/state")"
grep -q '"theme":{"v":"light"' <<<"$snap" || fail "restored state is not the backup's"
grep -q "\"epoch\":\"$EPOCH\"" <<<"$snap" && fail "the restore kept the old epoch"
echo "ok: restored from $BACKUP: backup's state, new epoch, browsers signed out"

echo "PASS"
