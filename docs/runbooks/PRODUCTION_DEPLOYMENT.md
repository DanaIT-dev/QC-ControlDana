# Production deployment

Шаблон: `infra/docker/compose.production.yaml`. Это не локальный compose: Redis **не публикует** порты на хост.

## Redis

- Только внутренняя Docker/overlay сеть, `protected-mode yes`, default user `off`.
- ACL-пользователи `sgr_api` и `sgr_worker`. Пароли — Docker secrets, не argv `redis-server`.
- Runtime: `REDIS_URL=rediss://sgr_api:...` (TLS), если Redis вне доверенной сети хоста; `rejectUnauthorized` нельзя отключать.
- `WORKER_REDIS_URL` обязателен и использует `sgr_worker`.
- `loadConfig()` в `NODE_ENV=production` завершает процесс, если нет ACL username/password, используется `local-development-only`, runtime DB URL принадлежит owner/migrator/bootstrap, или внешний Redis без `rediss://`.
- Проверка шаблона: `node scripts/security/validate-production-compose.mjs`.

## PostgreSQL

- `DATABASE_URL` — `sgr_app_user`
- `AUTH_DATABASE_URL` — `sgr_auth_user`
- `WORKER_DATABASE_URL` — `sgr_worker_user`
- `MIGRATION_DATABASE_URL` — `sgr_migrator` (только migrate/seed/provision)
- Хеши паролей в `user_credentials`; runtime `sgr_app` / `sgr_worker` не имеют GRANT.

## Ротация

- Redis: [REDIS_CREDENTIAL_ROTATION.md](./REDIS_CREDENTIAL_ROTATION.md)
- RLS HMAC: [RLS_OPERATIONS.md](../security/RLS_OPERATIONS.md)
