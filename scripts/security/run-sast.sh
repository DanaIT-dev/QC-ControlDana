#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(uname -m)" in
  x86_64|amd64) SCAN_PLATFORM=linux/amd64 ;;
  aarch64|arm64) SCAN_PLATFORM=linux/arm64 ;;
  *) SCAN_PLATFORM="" ;;
esac
PLATFORM_ARGS=()
if [[ -n "$SCAN_PLATFORM" ]]; then
  PLATFORM_ARGS=(--platform "$SCAN_PLATFORM")
fi
# shellcheck disable=SC1091
source "$ROOT/scripts/security/scanners.env"
OUT="$ROOT/test-results/security-audit"
TRIVY_CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy}"
mkdir -p "$OUT" "$TRIVY_CACHE"

cd "$ROOT"

echo "==> Semgrep Community (typescript, nodejs, react, nextjs, owasp, security-audit)"
docker run --rm "${PLATFORM_ARGS[@]}" \
  -v "$ROOT:/src" \
  "$SEMGREP_IMAGE" \
  semgrep scan \
    --config p/typescript \
    --config p/nodejs \
    --config p/react \
    --config p/nextjs \
    --config p/owasp-top-ten \
    --config p/security-audit \
    --metrics off \
    --json \
    --output /src/test-results/security-audit/semgrep.json \
    /src || true
node "$ROOT/scripts/security/check-semgrep-report.mjs" "$OUT/semgrep.json"

echo "==> Gitleaks working tree (redacted)"
docker run --rm "${PLATFORM_ARGS[@]}" \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --no-git --source /repo --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security-audit/gitleaks-workdir.json
echo "==> Gitleaks full git history (redacted)"
docker run --rm "${PLATFORM_ARGS[@]}" \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --source /repo --log-opts="--all" --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security-audit/gitleaks-history.json

echo "==> pnpm audit (production)"
pnpm audit --prod --json > "$OUT/pnpm-audit-prod.json" || true
echo "==> pnpm audit (dev)"
pnpm audit --dev --json > "$OUT/pnpm-audit-dev.json" || true
echo "==> pnpm audit (all)"
pnpm audit --json > "$OUT/pnpm-audit-all.json" || true

echo "==> Trivy filesystem"
docker run --rm "${PLATFORM_ARGS[@]}" \
  -v "$ROOT:/repo" \
  -v "$OUT:/out" \
  -v "$TRIVY_CACHE:/root/.cache" \
  "$TRIVY_IMAGE" \
  fs --skip-dirs node_modules --skip-dirs .next --skip-dirs dist --skip-dirs coverage \
    --scanners vuln,secret,misconfig --format json --output /out/trivy-fs.json /repo

echo "==> Trivy IaC / compose"
docker run --rm "${PLATFORM_ARGS[@]}" \
  -v "$ROOT:/repo" \
  -v "$OUT:/out" \
  -v "$TRIVY_CACHE:/root/.cache" \
  "$TRIVY_IMAGE" \
  config --format json --output /out/trivy-config.json /repo/infra/docker

echo "==> Trivy container images used by compose"
for image in \
  postgres:18 \
  redis:7-alpine \
  chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d \
  clamav/clamav:1.5.4@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0 \
  axllent/mailpit:v1.27.10@sha256:b1f1be18af530d939a11ee8820b379e0c88eeec204d904bfad68862adced3a5a
do
  safe_name="$(echo "$image" | tr '/:@' '___')"
  docker run --rm "${PLATFORM_ARGS[@]}" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$OUT:/out" \
    -v "$TRIVY_CACHE:/root/.cache" \
    "$TRIVY_IMAGE" \
    image --format json --output "/out/trivy-image-${safe_name}.json" "$image" || true
done

echo "SAST reports written to $OUT (gitignored)"
