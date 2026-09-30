#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/security/scanners.env"
OUT="$ROOT/test-results/security-audit"
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
    --output /src/test-results/security-audit/semgrep.json \
    /src || true
node "$ROOT/scripts/security/check-semgrep-report.mjs" "$OUT/semgrep.json"

echo "==> Gitleaks working tree (redacted)"
set +e
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --no-git --source /repo --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security-audit/gitleaks-workdir.json
echo "==> Gitleaks full git history (redacted)"
docker run --rm --platform linux/arm64 \
  -v "$ROOT:/repo" \
  "$GITLEAKS_IMAGE" \
  detect --source /repo --log-opts="--all" --redact --no-banner \
    --config /repo/.gitleaks.toml \
    --report-format json \
    --report-path /repo/test-results/security-audit/gitleaks-history.json
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
  rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff \
  clamav/clamav:1.5.4@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0 \
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
