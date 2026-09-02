# Безопасность

Источник истины для доступа — серверная сессия и `RegistryAccessScope`, не роль/userId из тела запроса и не клиентская фильтрация.

## Обязательные правила этого этапа

- CSRF на mutation-запросах, `mustChangePassword` блокирует остальной API
- cookie сессии: idle 12 часов, absolute 7 дней, SameSite=Lax, Secure в production
- Helmet CSP на JSON API (`default-src 'none'`); Next.js CSP с `frame-ancestors 'none'` и без `unsafe-eval` в production
- инструментальный аудит 2026-09-01: [SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md); предыдущий прогон 2026-08-28: [SECURITY_AUDIT_2026-08-28.md](../security/SECURITY_AUDIT_2026-08-28.md)
- capability проверяется на сервере (deny-by-default, без `role !== CONTRACTOR` fallthrough)
- `SUPER_ADMIN` не наследует права `ADMIN`; чтение бизнес-данных через `VIEW_ALL_BUSINESS_DATA` и RLS SELECT, мутации процесса — `403` / 0 строк
- вне scope запись уведомления неотличима от отсутствия (404)
- HTML писем экранируется, subject без CRLF
- секреты (SMTP password, MinIO, session, CSRF, B/C) не попадают в payload уведомлений, email, hydration, audit detail и client bundle
- `PUBLIC_APP_URL` задаётся конфигурацией; Host входящего запроса не используется для ссылок
- SMTP host/port только из env, без SSRF через пользовательский ввод
- rate limit на notification mutations
- bounded JSON payload, Decimal/Date сериализация на сервере
- select вместо отдачи Prisma-моделей
- open redirect запрещён: ссылки писем ведут только на `/acts/:id`

B/C коммерческие поля не возвращаются RESPONSIBLE_ENGINEER ни в одном канале, включая прямой SQL под runtime-ролью.

PostgreSQL RLS: отдельные роли migrator/API/auth/worker, `FORCE ROW LEVEL SECURITY`, HMAC transaction-local context. См. [RLS_OPERATIONS.md](../security/RLS_OPERATIONS.md). Хеши паролей — таблица `user_credentials` (GRANT только `sgr_auth`). Запись `sla_clocks` для `sgr_app` только через `sgr_upsert_sla_clock` в пределах видимости связанного дефекта. Redis production всегда с AUTH и без публикации порта.

Development-база `sgr_registry` не тестовая. Integration — только `sgr_registry_test`. Playwright — только `sgr_registry_e2e` (отдельный Redis DB/prefix и MinIO bucket). Fixture/seed/cleanup E2E fail-closed: отказ до INSERT/UPDATE/DELETE, если цель не E2E. Provisioning SUPER_ADMIN атомарный (`--replace` с TTY-подтверждением email); диагностика наличия идёт через `sgr_active_super_admins()`, без `passwordHash` и без отключения RLS у runtime.
