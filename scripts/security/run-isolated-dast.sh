#!/usr/bin/env bash
# Isolated local DAST: disposable Postgres DB, Redis DB 15, dedicated MinIO bucket.
# Does not drop sgr_registry / sgr_registry_test or scan non-loopback hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ISOLATED_DB="${ISOLATED_DB:-sgr_security_audit_test}"
BUCKET="${S3_AUDIT_BUCKET:-sgr-audit-attachments}"
REDIS_DB="${REDIS_AUDIT_DB:-15}"

case "$ISOLATED_DB" in
  *[!a-zA-Z0-9_]* | "")
    echo "refusing unsafe isolated database name" >&2
    exit 1
    ;;
esac

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# Force loopback audit ports after dotenv so local .env WEB_PORT/API_PORT cannot leak onto 3000/3001.
WEB_PORT=3100
API_PORT=3101
WORKER_PORT=3102

remap_db() {
  python3 - "$1" "$ISOLATED_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url, name = sys.argv[1], sys.argv[2]
parts = urlsplit(url)
print(urlunsplit((parts.scheme, parts.netloc, f"/{name}", parts.query, parts.fragment)), end="")
PY
}

remap_redis() {
  python3 - "$1" "$REDIS_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url, db = sys.argv[1], sys.argv[2]
parts = urlsplit(url)
path = f"/{db}"
print(urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment)), end="")
PY
}

export DATABASE_URL="$(remap_db "$DATABASE_URL")"
export AUTH_DATABASE_URL="$(remap_db "$AUTH_DATABASE_URL")"
export WORKER_DATABASE_URL="$(remap_db "$WORKER_DATABASE_URL")"
export MIGRATION_DATABASE_URL="$(remap_db "$MIGRATION_DATABASE_URL")"
export REDIS_URL="$(remap_redis "${REDIS_URL:-redis://127.0.0.1:6379}")"
export REDIS_KEY_PREFIX="sgr-audit"
export S3_BUCKET="$BUCKET"
export S3_TEST_BUCKET="$BUCKET"
export API_HOST="127.0.0.1"
export API_PORT
export WEB_PORT
export WEB_ORIGIN="http://127.0.0.1:${WEB_PORT}"
export NEXT_PUBLIC_API_URL="http://127.0.0.1:${API_PORT}"
export PUBLIC_APP_URL="$WEB_ORIGIN"
export WORKER_HEALTH_PORT="$WORKER_PORT"
export SGR_KEEP_PROCESS_ENV=1
export EMAIL_ENABLED="${EMAIL_ENABLED:-true}"
export SMTP_HOST="${SMTP_HOST:-127.0.0.1}"
export SMTP_PORT="${SMTP_PORT:-1025}"

echo "target host: 127.0.0.1"
echo "database: isolated disposable database ${ISOLATED_DB}"
echo "external network targets: none"
echo "real SMTP: disabled (Mailpit/local stub)"
echo "real data: none"

docker exec sgr-registry-postgres psql -U sgr_registry -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${ISOLATED_DB} WITH (FORCE);"
docker exec sgr-registry-postgres psql -U sgr_registry -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${ISOLATED_DB};"
docker exec sgr-registry-postgres psql -U sgr_registry -d postgres -v ON_ERROR_STOP=1 \
  -c "GRANT CONNECT, CREATE, TEMP ON DATABASE ${ISOLATED_DB} TO sgr_app, sgr_auth, sgr_worker, sgr_owner;"
docker exec sgr-registry-postgres psql -U sgr_registry -d "${ISOLATED_DB}" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; ALTER SCHEMA public OWNER TO sgr_owner;"

pnpm db:migrate
# Insert HMAC secret and CONNECT grants on *_test databases, including the isolated one.
pnpm db:roles:provision
pnpm --filter @sgr-registry/database seed

(
  cd "$ROOT/apps/api"
  node --input-type=module <<'EOF'
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
});
const bucket = process.env.S3_BUCKET;
try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}
EOF
)

API_PID=""
WEB_PID=""
WORKER_PID=""
cleanup() {
  if [[ -n "${API_PID}" ]]; then kill "${API_PID}" 2>/dev/null || true; fi
  if [[ -n "${WEB_PID}" ]]; then kill "${WEB_PID}" 2>/dev/null || true; fi
  if [[ -n "${WORKER_PID}" ]]; then kill "${WORKER_PID}" 2>/dev/null || true; fi
  docker exec sgr-registry-postgres psql -U sgr_registry -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${ISOLATED_DB} WITH (FORCE);" >/dev/null 2>&1 || true
  docker exec sgr-registry-redis redis-cli -n "${REDIS_DB}" FLUSHDB >/dev/null 2>&1 || true
}
trap cleanup EXIT

pnpm --filter @sgr-registry/api exec tsx src/main.ts >/tmp/sgr-audit-api.log 2>&1 &
API_PID=$!
pnpm --filter @sgr-registry/web exec next dev --port "${WEB_PORT}" -H 127.0.0.1 >/tmp/sgr-audit-web.log 2>&1 &
WEB_PID=$!
pnpm --filter @sgr-registry/worker exec tsx src/main.ts >/tmp/sgr-audit-worker.log 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 180); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${WEB_PORT}/login" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${WORKER_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null
curl -fsS "http://127.0.0.1:${WEB_PORT}/login" >/dev/null

WEB_ORIGIN="$WEB_ORIGIN" API_ORIGIN="http://127.0.0.1:${API_PORT}" bash "$ROOT/scripts/security/run-dast.sh"
