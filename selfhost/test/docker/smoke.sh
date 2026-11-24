#!/usr/bin/env bash
# Container smoke test: runs the image hardened (read-only root, no capabilities), then checks
# health, login, non-root user, graceful stop with an open stream, and persistence across restarts.
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
curl -fsS -b "$JAR" "$BASE/api/health" | grep -q '"app":"wickline"' || fail "authenticated /api/health"
curl -fsS -b "$JAR" "$BASE/" | grep -q '<title>Wickline</title>' || fail "app page"
if curl -sS -D - -o /dev/null -b "$JAR" "$BASE/api/health" | grep -qi '^access-control-allow-origin'; then fail "CORS header leaked"; fi
echo "ok: login, app and API"

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
curl -fsS -b "$JAR" "$BASE/api/health" | grep -q '"app":"wickline"' || fail "session lost after restart"
docker exec "$NAME" sh -c 'test -s /data/wickline.db' || fail "database missing in /data"
echo "ok: session and database survived the restart"

echo "PASS"
