#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/security/scanners.env"
OUT="$ROOT/test-results/security"
TRIVY_CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy}"
mkdir -p "$OUT" "$TRIVY_CACHE"

cd "$ROOT"

echo "==> Semgrep Community (typescript, nodejs, react, nextjs, owasp, security-audit)"
docker run --rm --platform linux/arm64 \
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
    --output /src/test-results/security/semgrep.json \
    /src || true

echo "==> Gitleaks working tree (redacted)"
set +e
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --no-git --source /repo --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security/gitleaks-workdir.json
echo "==> Gitleaks full git history (redacted)"
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --source /repo --log-opts="--all" --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security/gitleaks-history.json
set -e

echo "==> pnpm audit (production)"
pnpm audit --prod --json > "$OUT/pnpm-audit-prod.json" || true
echo "==> pnpm audit (dev)"
pnpm audit --dev --json > "$OUT/pnpm-audit-dev.json" || true
echo "==> pnpm audit (all)"
pnpm audit --json > "$OUT/pnpm-audit-all.json" || true

echo "==> Trivy filesystem"
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  -v "$OUT:/out" \
  -v "$TRIVY_CACHE:/root/.cache" \
  "$TRIVY_IMAGE" \
  fs --skip-dirs node_modules --skip-dirs .next --skip-dirs dist --skip-dirs coverage \
    --scanners vuln,secret,misconfig --format json --output /out/trivy-fs.json /repo || true

echo "==> Trivy IaC / compose"
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  -v "$OUT:/out" \
  -v "$TRIVY_CACHE:/root/.cache" \
  "$TRIVY_IMAGE" \
  config --format json --output /out/trivy-config.json /repo/infra/docker || true

echo "==> Trivy container images used by compose"
for image in \
  postgres:18 \
  redis:7-alpine \
  minio/minio:RELEASE.2025-04-22T22-12-26Z \
  clamav/clamav-debian:1.4@sha256:f6da737f9399d6a1851c463b2f88d02021a67f969ec42dd6e1751fecf7c3de4f \
  axllent/mailpit:v1.27.10@sha256:b1f1be18af530d939a11ee8820b379e0c88eeec204d904bfad68862adced3a5a
do
  safe_name="$(echo "$image" | tr '/:@' '___')"
  docker run --rm --platform linux/arm64 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$OUT:/out" \
    -v "$TRIVY_CACHE:/root/.cache" \
    "$TRIVY_IMAGE" \
    image --format json --output "/out/trivy-image-${safe_name}.json" "$image" || true
done

echo "SAST reports written to $OUT (gitignored)"
