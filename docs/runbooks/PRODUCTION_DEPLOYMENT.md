# Production deployment

Манифест: `infra/docker/compose.production.yaml`. Это не локальный compose.

Наружу публикуются только порты `80` и `443` reverse proxy. PostgreSQL, Redis, MinIO, ClamAV, API, worker и web остаются в сети `sgr_internal`. HSTS задаётся в `infra/docker/Caddyfile.production` только на порту 443.

Образы:

```bash
docker build -f infra/docker/Dockerfile.runtime -t sgr-registry-runtime:$SGR_IMAGE_TAG .
docker build -f infra/docker/Dockerfile.web -t sgr-registry-web:$SGR_IMAGE_TAG .
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
