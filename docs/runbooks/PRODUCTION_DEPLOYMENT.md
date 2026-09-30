# Production deployment

Манифест: `infra/docker/compose.production.yaml`. Это не локальный compose.

Наружу публикуются только порты `80` и `443` reverse proxy. PostgreSQL, Redis, MinIO, ClamAV, API, worker и web остаются в сети `sgr_internal`. HSTS задаётся в `infra/docker/Caddyfile.production` только на порту 443.

Образы закреплены. Сторонние ссылки имеют вид `repository:version@sha256:...`. `latest` запрещён. Собственные образы собираются с тегом полного Git SHA и публикуются только вместе с digest:

```bash
export SGR_IMAGE_TAG="$(git rev-parse HEAD)"
docker buildx build --platform linux/amd64 --load -f infra/docker/Dockerfile.runtime --target runtime \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-runtime:$SGR_IMAGE_TAG" .
docker buildx build --platform linux/amd64 --load -f infra/docker/Dockerfile.runtime --target migrator \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-migrator:$SGR_IMAGE_TAG" .
docker buildx build --platform linux/amd64 --load -f infra/docker/Dockerfile.web \
  --build-arg SGR_GIT_SHA="$SGR_IMAGE_TAG" \
  -t "sgr-registry-web:$SGR_IMAGE_TAG" .
export SGR_RUNTIME_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-runtime:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
export SGR_MIGRATOR_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-migrator:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
export SGR_WEB_IMAGE_DIGEST="sha256:$(docker image inspect "sgr-registry-web:$SGR_IMAGE_TAG" --format '{{.Id}}' | cut -d: -f2)"
```

`SGR_IMAGE_TAG` должен быть 40 hex-символов. Digest — `sha256` и 64 hex-символа. `pnpm ops:readiness` отвергает `latest`, tag без digest и платформу вне `linux/amd64` и `linux/arm64`. Обновление стороннего образа: выбрать официальный patch, прогнать Trivy, заменить manifest digest в `infra/docker/image-pins.json` и compose, задеплоить. Откат — предыдущий digest, не прежний плавающий tag.

Целевая production-архитектура — `linux/amd64`. `linux/arm64` допустим только как второй вариант. Локальная проверка на arm64 не подтверждает amd64 production. Сборка `linux/amd64` на этой машине выполняется через buildx. Каталог digest: `infra/docker/image-pins.json`. В compose для образов с подтверждённым manifest list используется digest списка и `platform: ${SGR_PLATFORM:-linux/amd64}`. Manifest digest не равен platform digest. Git SHA не равен Docker digest. Локальный image id не равен digest в registry.

MinIO не имеет подтверждённого `linux/amd64` digest: анонимный lookup registry вернул `insufficient_scope`. Compose требует `SGR_MINIO_IMAGE_DIGEST` и не подставляет локальный arm64 image id. `multi-arch registry manifest: NOT PUBLISHED`. Это внешний шаг выкладки, а не дефект кода.

Четыре разные операции не смешиваются: local single-platform validation, multi-platform build, registry manifest publication, production deployment. Подробности, SBOM, OpenVEX и security gate: `docs/security/SUPPLY_CHAIN.md`.

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
