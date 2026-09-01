#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/security/scanners.env"
OUT="$ROOT/test-results/security-audit"
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
from urllib.parse import urlparse
import os
import sys

out = Path(sys.argv[1])
web = urlparse(os.environ.get("WEB_ORIGIN", "http://127.0.0.1:3000"))
api = urlparse(os.environ.get("API_ORIGIN", "http://127.0.0.1:3001"))
web_port = web.port or (443 if web.scheme == "https" else 80)
api_port = api.port or (443 if api.scheme == "https" else 80)
web_base = f"http://host.docker.internal:{web_port}"
api_base = f"http://host.docker.internal:{api_port}"
links = [
    f"{web_base}/",
    f"{web_base}/login",
    f"{web_base}/registry",
    f"{web_base}/notifications",
    f"{web_base}/deadlines",
    f"{web_base}/system-status",
    f"{web_base}/acts/new",
    f"{web_base}/login?next=https://evil.example",
    f"{api_base}/api/health",
    f"{api_base}/api/ready",
    f"{api_base}/api/auth/login",
    f"{api_base}/api/registry/defects",
    f"{api_base}/api/notifications",
    f"{api_base}/api/sla/items",
    f"{api_base}/api/system-status",
    f"{api_base}/api/attachments/11111111-1111-4111-8111-111111111111",
    f"{api_base}/api/acts/11111111-1111-4111-8111-111111111111/chat",
    f"{api_base}/api/acts/11111111-1111-4111-8111-111111111111/chat/mention-candidates",
    f"{api_base}/api/attachments/..%2f..%2fetc%2fpasswd",
    f"{api_base}/api/registry/defects?search=%3Cscript%3Ealert(1)%3C/script%3E",
    f"{api_base}/api/registry/defects?search=%27%20OR%201%3D1%20--",
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
