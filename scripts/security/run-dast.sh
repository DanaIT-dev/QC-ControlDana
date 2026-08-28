#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/security/scanners.env"
OUT="$ROOT/test-results/security"
mkdir -p "$OUT"

WEB_ORIGIN="${WEB_ORIGIN:-http://127.0.0.1:3000}"
API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:3001}"
SITEMAP_PORT="${ZAP_SITEMAP_PORT:-3999}"

assert_local() {
  local url="$1"
  case "$url" in
    http://127.0.0.1:*|http://localhost:*|http://host.docker.internal:*) ;;
    *)
      echo "refusing non-local DAST target: $url" >&2
      exit 1
      ;;
  esac
}

assert_local "$WEB_ORIGIN"
assert_local "$API_ORIGIN"

if ! curl -fsS "$API_ORIGIN/api/health" >/dev/null; then
  echo "API health is not 200 at $API_ORIGIN" >&2
  exit 1
fi
if ! curl -fsS "$WEB_ORIGIN/login" >/dev/null; then
  echo "Web login is not reachable at $WEB_ORIGIN" >&2
  exit 1
fi

SITEMAP_DIR="$OUT/zap-sitemap-www"
mkdir -p "$SITEMAP_DIR"
SITEMAP="$SITEMAP_DIR/zap-unauth-sitemap.html"
python3 - "$SITEMAP" <<'PY'
from pathlib import Path
import sys
out = Path(sys.argv[1])
links = [
    "http://host.docker.internal:3000/",
    "http://host.docker.internal:3000/login",
    "http://host.docker.internal:3000/registry",
    "http://host.docker.internal:3000/notifications",
    "http://host.docker.internal:3000/deadlines",
    "http://host.docker.internal:3000/system-status",
    "http://host.docker.internal:3000/acts/new",
    "http://host.docker.internal:3000/login?next=https://evil.example",
    "http://host.docker.internal:3001/api/health",
    "http://host.docker.internal:3001/api/ready",
    "http://host.docker.internal:3001/api/auth/login",
    "http://host.docker.internal:3001/api/registry/defects",
    "http://host.docker.internal:3001/api/notifications",
    "http://host.docker.internal:3001/api/sla/items",
    "http://host.docker.internal:3001/api/system-status",
    "http://host.docker.internal:3001/api/attachments/11111111-1111-4111-8111-111111111111",
    "http://host.docker.internal:3001/api/attachments/11111111-1111-4111-8111-111111111111/content",
    "http://host.docker.internal:3001/api/attachments/..%2f..%2fetc%2fpasswd",
    "http://host.docker.internal:3001/api/registry/defects?search=%3Cscript%3Ealert(1)%3C/script%3E",
    "http://host.docker.internal:3001/api/registry/defects?search=%27%20OR%201%3D1%20--",
]
items = "\n".join(f'      <li><a href="{url}">{url}</a></li>' for url in links)
out.write_text(
    "<!doctype html><html><body><ul>\n" + items + "\n    </ul></body></html>\n",
    encoding="utf-8",
)
PY

# Ephemeral local-only helper so the ZAP container can follow API/Web paths.
# Bound on all interfaces for the scan window, then killed in the EXIT trap.
python3 -m http.server "$SITEMAP_PORT" --bind 0.0.0.0 --directory "$SITEMAP_DIR" >/tmp/zap-sitemap-http.log 2>&1 &
SITEMAP_PID=$!
cleanup() {
  kill "$SITEMAP_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 0.4
if ! curl -fsS "http://127.0.0.1:${SITEMAP_PORT}/zap-unauth-sitemap.html" >/dev/null; then
  echo "local ZAP sitemap is not reachable on 127.0.0.1:${SITEMAP_PORT}" >&2
  exit 1
fi

run_zap() {
  local name="$1"
  local target="$2"
  assert_local "$target"
  echo "==> OWASP ZAP unauthenticated baseline ($name) $target"
  docker run --rm --platform linux/arm64 \
    --add-host=host.docker.internal:host-gateway \
    -v "$OUT:/zap/wrk:rw" \
    "$ZAP_IMAGE" \
    zap-baseline.py -t "$target" -m 4 \
      -J "zap-${name}.json" -w "zap-${name}.md" -I
}

run_zap "web-unauth" "http://host.docker.internal:${WEB_ORIGIN##*:}"
run_zap "api-unauth" "http://host.docker.internal:${API_ORIGIN##*:}/api/health"
run_zap "sitemap-unauth" "http://host.docker.internal:${SITEMAP_PORT}/zap-unauth-sitemap.html"

node "$ROOT/scripts/security/dast-authenticated.mjs"

echo "DAST reports written to $OUT (gitignored)"
