#!/bin/sh
# Generate Redis ACL from env or Docker secret files. Passwords are never passed
# as redis-server arguments and are hashed before being written to the ACL file.
set -eu

read_secret() {
  name="$1"
  file_var="${name}_FILE"
  eval "file_path=\${${file_var}:-}"
  eval "direct=\${${name}:-}"
  if [ -n "${file_path}" ]; then
    if [ ! -r "${file_path}" ]; then
      echo "${file_var} is not readable" >&2
      exit 1
    fi
    cat "${file_path}"
    return
  fi
  if [ -n "${direct}" ]; then
    printf '%s' "${direct}"
    return
  fi
  echo "${name} is required" >&2
  exit 1
}

sha256_hex() {
  printf '%s' "$1" | sha256sum | cut -d ' ' -f1
}

if [ -n "${REDIS_PASSWORD_FILE:-}" ] || [ -n "${REDIS_PASSWORD:-}" ]; then
  SHARED_PASSWORD="$(read_secret REDIS_PASSWORD)"
else
  SHARED_PASSWORD=""
fi

if [ -n "${REDIS_API_PASSWORD_FILE:-}" ] || [ -n "${REDIS_API_PASSWORD:-}" ]; then
  API_PASSWORD="$(read_secret REDIS_API_PASSWORD)"
else
  API_PASSWORD="${SHARED_PASSWORD}"
fi

if [ -n "${REDIS_WORKER_PASSWORD_FILE:-}" ] || [ -n "${REDIS_WORKER_PASSWORD:-}" ]; then
  WORKER_PASSWORD="$(read_secret REDIS_WORKER_PASSWORD)"
else
  WORKER_PASSWORD="${SHARED_PASSWORD}"
fi

if [ -z "${API_PASSWORD}" ] || [ -z "${WORKER_PASSWORD}" ]; then
  echo "Redis ACL passwords are required" >&2
  exit 1
fi

API_HASH="$(sha256_hex "${API_PASSWORD}")"
WORKER_HASH="$(sha256_hex "${WORKER_PASSWORD}")"
ACL_FILE="${REDIS_ACL_FILE:-/tmp/sgr-users.acl}"
umask 077
cat >"${ACL_FILE}" <<EOF
user default off
user sgr_api on #${API_HASH} ~sgr:* ~sgr-test:* ~sgr-e2e:* ~sgr-audit:* ~bull:* &* -@all +@connection +@read +@write +@set +@sortedset +@list +@hash +@stream +@blocking +@scripting +@pubsub +@transaction +info +echo +time +ping +select +config|get +cluster|slots +cluster|nodes +cluster|info +client|setname +client|id +client|setinfo -FLUSHALL -FLUSHDB -SHUTDOWN -DEBUG -MODULE -SAVE -BGSAVE
user sgr_worker on #${WORKER_HASH} ~sgr:* ~sgr-test:* ~sgr-e2e:* ~sgr-audit:* ~bull:* &* -@all +@connection +@read +@write +@set +@sortedset +@list +@hash +@stream +@blocking +@scripting +@pubsub +@transaction +info +echo +time +ping +select +config|get +cluster|slots +cluster|nodes +cluster|info +client|setname +client|id +client|setinfo -FLUSHALL -FLUSHDB -SHUTDOWN -DEBUG -MODULE -SAVE -BGSAVE
EOF

# EVAL/EVALSHA remain available via +@scripting because BullMQ Lua workers require them.
exec redis-server --aclfile "${ACL_FILE}" --protected-mode yes --bind 0.0.0.0 --port 6379
