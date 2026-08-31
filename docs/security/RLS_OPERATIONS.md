# Операции PostgreSQL RLS

RLS — второй уровень защиты. Guards, capabilities, DTO `.strict()`, CSRF, serializers, безопасный `404` и `RegistryAccessScope` остаются обязательными. Акты создаются только вручную. Интеграция с 1С исключена и не является каналом поступления данных.

## Роли

| Роль           | LOGIN        | Назначение                                                                           |
| -------------- | ------------ | ------------------------------------------------------------------------------------ |
| `sgr_owner`    | нет          | Владелец schema/tables/functions. `BYPASSRLS` только здесь. Не используется runtime. |
| `sgr_app`      | нет (группа) | API. Член: `sgr_app_user` (`DATABASE_URL`).                                          |
| `sgr_auth`     | нет (группа) | `users` + `INSERT`/`SELECT` login-audit (`USER`/`SESSION`). Член: `sgr_auth_user`.   |
| `sgr_worker`   | нет (группа) | Outbox, scan, SLA, email; `SELECT` audit только своих SYSTEM-действий.               |
| `sgr_migrator` | да           | Член `sgr_owner`. Только `MIGRATION_DATABASE_URL` и seed.                            |

Runtime-роли: `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`. Не являются членами друг друга. Не могут `SET ROLE sgr_owner`.

Bootstrap `sgr_registry` — только Docker/`POSTGRES_ADMIN_URL`. Production `loadConfig` отклоняет bootstrap/owner/migrator на runtime URL.

## Provisioning

```bash
pnpm db:roles:provision
```

Требует `POSTGRES_ADMIN_URL` (superuser), `DATABASE_URL`, `AUTH_DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `RLS_CONTEXT_SECRET` (≥32). Пароли не печатает. Production: `CONFIRM_PRODUCTION_DB_ROLES=I_UNDERSTAND_PRODUCTION_DB_ROLES`. Повторный запуск идемпотентен и не расширяет права молча (отклоняет SUPERUSER/BYPASSRLS на runtime).

Порядок: provision → `pnpm db:migrate` (через `MIGRATION_DATABASE_URL`) → повторный provision (вставляет секрет, если таблица уже есть) → seed только migrator/owner.

Повторный `prisma migrate deploy` — безопасный no-op.

## Контекст запроса

API открывает interactive Prisma transaction, первой операцией вызывает `sgr_set_request_context(token)`. Token: `v1.{payload}.{hmac-sha256}` где payload `user|{uuid}|{sessionVersion}|{issuedAtMs}|{nonce}`. Worker: `worker|{issuedAtMs}|{nonce}`. Политики доверяют только GUC, подписанному тем же секретом (`sgr_guc_intact`). Обычный `set_config` userId/role не подменяет контекст.

Секрет хранится в `sgr_rls_secrets` без GRANT runtime. Ошибки функции: `RLS context rejected` / `28000`, без текста секрета.

Prisma `INSERT ... RETURNING` требует SELECT-политику на новую строку. Чтобы CONTRACTOR не читал `audit_logs`, а не-ADMIN не читал `outbox_events`, запись идёт через `sgr_insert_audit_log` / `sgr_insert_outbox_event` (`SECURITY DEFINER`, `session_user` ∈ runtime-ролей, без GRANT PUBLIC).

## Rotation `RLS_CONTEXT_SECRET`

1. Выпустить новый секрет в env (не коммитить).
2. `INSERT INTO sgr_rls_secrets (secret) VALUES ($new)` от имени owner/migrator.
3. Перезапустить API и worker с новым env (подпись и проверка читают активную строку `revoked_at IS NULL`, самую новую).
4. После перекрытия сессий пометить старую строку `revoked_at = now()`.
5. Короткоживущий token (60 с): после ротации старые token отклонются.

Overlap двух активных секретов эта версия не поддерживает: активен один секрет. Перезапуск процессов должен быть одновременным с переключением строки.

## Диагностика

```sql
SELECT current_user, session_user;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'sgr_%';
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
SELECT * FROM pg_policies WHERE schemaname = 'public';
```

Пустой SELECT без контекста — ожидаемый deny-by-default, не «сломалась база». Не запускать `SET ROLE sgr_owner` и не отключать RLS с runtime-ролей.

## Rollback / recovery

`prisma migrate` не откатывает эту миграцию. Recovery: restore из backup или новая forward-миграция. Запрещено включать SUPERUSER/BYPASSRLS в runtime URL «чтобы починить доступ».

## Запреты запуска

- Runtime процессы не используют owner, migrator, `sgr_registry`, `postgres`.
- Migrations — только `MIGRATION_DATABASE_URL`.
- Не reset development-базы ради RLS.
- Старые migration-файлы и checksums не менять.
