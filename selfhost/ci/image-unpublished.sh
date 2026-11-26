#!/usr/bin/env bash
# Exits 0 only when the registry confirms that <repo>:<tag> is not published, 1 when it is, and 2
# when that cannot be confirmed (auth, rate limit, outage, malformed answer). Never fails open: a
# release tag is immutable, so "unknown" must stop a release (PLAN §5.4).
#
#   GH_TOKEN=<token with packages:read> selfhost/ci/image-unpublished.sh mtrifan/wickline 0.1.9-sh.1
set -uo pipefail
repo="$1"; tag="$2"
reg=https://ghcr.io
accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

token=$(curl -fsS -u "x:${GH_TOKEN:?GH_TOKEN is required}" "$reg/token?scope=repository:$repo:pull" | jq -er .token) \
  || { echo "::error::could not get a registry token"; exit 2; }

# Every page of the tag list (the registry paginates through Link: <…>; rel="next").
tag_listed() {
  local url="$reg/v2/$repo/tags/list?n=1000" headers body next
  while [ -n "$url" ]; do
    headers=$(mktemp)
    body=$(curl -fsS -D "$headers" -H "Authorization: Bearer $token" "$url") || { rm -f "$headers"; return 2; }
    jq -e '.tags | type == "array"' <<<"$body" >/dev/null || { rm -f "$headers"; return 2; }
    if jq -e --arg t "$tag" '.tags | index($t) != null' <<<"$body" >/dev/null; then rm -f "$headers"; return 0; fi
    next=$(tr -d '\r' < "$headers" | sed -n 's/^[Ll]ink: *<\([^>]*\)>; *rel="next".*/\1/p' | head -n 1)
    rm -f "$headers"
    case "$next" in ''|http*) url="$next" ;; *) url="$reg$next" ;; esac
  done
  return 1
}

for attempt in 1 2 3; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -H "Accept: $accept" "$reg/v2/$repo/manifests/$tag") || code=000
  case "$code" in
    200) echo "$repo:$tag is already published"; exit 1 ;;
    404)
      # A 404 can also mean "exists in a format the Accept header does not cover": confirm.
      tag_listed; listed=$?
      if [ "$listed" = 0 ]; then echo "$repo:$tag is already published"; exit 1; fi
      if [ "$listed" = 1 ]; then echo "$repo:$tag is not published"; exit 0; fi
      echo "registry tag list unavailable (attempt $attempt)" ;;
    *) echo "registry answered $code (attempt $attempt)" ;;
  esac
  sleep $((attempt * 10))
done
echo "::error::could not confirm that $repo:$tag is unpublished; not releasing"
exit 2
