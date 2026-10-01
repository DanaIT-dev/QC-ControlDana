#!/bin/sh
# Builds the SeaweedFS S3 identity file from environment or secret files, then
# starts the official image entrypoint. The official entrypoint drops to uid 1000.
set -eu

access="${S3_ACCESS_KEY_ID:-}"
secret="${S3_SECRET_ACCESS_KEY:-}"
if [ -z "$access" ] && [ -n "${S3_ACCESS_KEY_FILE:-}" ]; then
  access="$(cat "$S3_ACCESS_KEY_FILE")"
fi
if [ -z "$secret" ] && [ -n "${S3_SECRET_KEY_FILE:-}" ]; then
  secret="$(cat "$S3_SECRET_KEY_FILE")"
fi
access="$(printf '%s' "$access" | tr -d '\r\n')"
secret="$(printf '%s' "$secret" | tr -d '\r\n')"
if [ -z "$access" ] || [ -z "$secret" ]; then
  echo "object storage credentials are missing" >&2
  exit 1
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

umask 077
mkdir -p /tmp/seaweed-s3
printf '{\n  "identities": [{\n    "name": "sgr",\n    "credentials": [{ "accessKey": "%s", "secretKey": "%s" }],\n    "actions": ["Admin", "Read", "Write", "List", "Tagging"]\n  }]\n}\n' \
  "$(json_escape "$access")" "$(json_escape "$secret")" > /tmp/seaweed-s3/config.json
chown -R 1000:1000 /tmp/seaweed-s3
chmod 750 /tmp/seaweed-s3
chmod 640 /tmp/seaweed-s3/config.json
exec /entrypoint.sh mini \
  -dir=/data \
  -s3 \
  -s3.config=/tmp/seaweed-s3/config.json \
  -s3.port=9000 \
  -s3.autoCreateBucket=true \
  -master.telemetry=false
