#!/usr/bin/env bash
set -euo pipefail

API="${SMOKE_API_ORIGIN:-http://127.0.0.1:3011}"
WEB="${SMOKE_WEB_ORIGIN:-http://127.0.0.1:3010}"

case "$API" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing non-local API: $API" >&2; exit 1 ;;
esac
case "$WEB" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refusing non-local Web: $WEB" >&2; exit 1 ;;
esac

api_headers="$(curl -fsSI "$API/api/health")"
echo "$api_headers" | grep -qi "content-security-policy:.*default-src 'none'"
echo "$api_headers" | grep -qi "content-security-policy:.*frame-ancestors 'none'"
echo "$api_headers" | grep -qi "x-content-type-options: nosniff"
echo "$api_headers" | grep -qi "x-frame-options: DENY"
echo "$api_headers" | grep -qi "strict-transport-security:"

web_headers="$(curl -fsSI "$WEB/login")"
csp_headers="$(echo "$web_headers" | grep -i '^content-security-policy:')"
echo "$csp_headers" | grep -qi "content-security-policy:"
echo "$csp_headers" | grep -qi "frame-ancestors 'none'"
echo "$web_headers" | grep -qi "x-frame-options: DENY"
echo "$web_headers" | grep -qi "x-content-type-options: nosniff"
if echo "$csp_headers" | grep -qi "unsafe-eval"; then
  echo "production web CSP must not include unsafe-eval" >&2
  exit 1
fi

echo "production security headers OK"
