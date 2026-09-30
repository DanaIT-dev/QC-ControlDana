# Production deployment

Манифест: `infra/docker/compose.production.yaml`. Это не локальный compose.

Наружу публикуются только порты `80` и `443` reverse proxy. PostgreSQL, Redis, MinIO, ClamAV, API, worker и web остаются в сети `sgr_internal`. HSTS задаётся в `infra/docker/Caddyfile.production` только на порту 443.

Образы закреплены. Сторонние ссылки имеют вид `repository:version@sha256:...`. `latest` запрещён. Собственные образы собираются с тегом полного Git SHA и публикуются только вместе с digest:

```bash
export SGR_IMAGE_TAG="$(git rev-parse HEAD)"
docker build -f infra/docker/Dockerfile.runtime --target runtime \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-runtime:$SGR_IMAGE_TAG" .
docker build -f infra/docker/Dockerfile.runtime --target migrator \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-migrator:$SGR_IMAGE_TAG" .
docker build -f infra/docker/Dockerfile.web \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-web:$SGR_IMAGE_TAG" .
export SGR_RUNTIME_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-runtime:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
export SGR_MIGRATOR_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-migrator:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
export SGR_WEB_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-web:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
```

`SGR_IMAGE_TAG` должен быть 40 hex-символов. Digest — `sha256` и 64 hex-символа. `pnpm ops:readiness` отвергает `latest` и плавающий tag. Обновление стороннего образа: выбрать новый digest, прогнать Trivy image, заменить строку в compose, задеплоить. Откат — предыдущий digest, не прежний плавающий tag.

Проверенная платформа образов на этой машине — `linux/arm64`. Digest Caddy, PostgreSQL, Redis, Node и ClamAV — manifest list, где lookup прошёл. MinIO `sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e` закреплён по локально скачанному образу: анонимный lookup registry отклонён, поэтому amd64 для этого digest здесь не подтверждался.

Инвентарь development MinIO без вывода ключей и содержимого:

```bash
pnpm --filter @sgr-registry/database exec tsx scripts/inventory-minio.ts
```

Секреты лежат в `infra/docker/secrets/` и не коммитятся. Шаблон имён переменных: `.env.production.example`. Проверка без печати значений:

```bash
pnpm ops:readiness
node scripts/security/validate-production-compose.mjs
```

`loadConfig()` при `NODE_ENV=production` завершает процесс, если секрет короткий, тестовый или совпадает с development-значением, если origin не HTTPS, если SMTP указывает на loopback/Mailpit, или если runtime-роль базы не равна `sgr_app_user` / `sgr_auth_user` / `sgr_worker_user`.

Миграции — профиль `migrate`. Seed и reset в этот compose не входят. `prisma/seed.ts` при `NODE_ENV=production` завершается до открытия соединения.

## Redis

- Только внутренняя сеть, `protected-mode yes`, default user `off`.
- ACL-пользователи `sgr_api` и `sgr_worker`. Пароли — Docker secrets, не argv `redis-server`.
- Runtime: `REDIS_URL=rediss://sgr_api:...`, если Redis вне доверенной сети хоста; `rejectUnauthorized` нельзя отключать.
- `WORKER_REDIS_URL` обязателен и использует `sgr_worker`.

## PostgreSQL и тома

- `DATABASE_URL` — `sgr_app_user`
- `AUTH_DATABASE_URL` — `sgr_auth_user`
- `WORKER_DATABASE_URL` — `sgr_worker_user`
- `MIGRATION_DATABASE_URL` — `sgr_migrator`
- Тома PostgreSQL, MinIO, Redis и ClamAV — named volumes. Backup пишется в отдельный `BACKUP_ROOT`.
- Том сервера должен быть зашифрован средствами площадки. См. [THREAT_MODEL.md](../security/THREAT_MODEL.md).

Лимиты CPU/памяти, `init`, `stop_grace_period`, healthcheck и ротация json-логов заданы в compose.

## Связанные процедуры

- [Первый запуск и откат](./RELEASE_AND_ROLLBACK.md)
- [Backup и восстановление](./BACKUP_AND_RESTORE.md)
- [Мониторинг](./MONITORING.md)
- [Инцидент](./INCIDENT_RESPONSE.md)
- [Ротация Redis](./REDIS_CREDENTIAL_ROTATION.md)
- [RLS](../security/RLS_OPERATIONS.md)
