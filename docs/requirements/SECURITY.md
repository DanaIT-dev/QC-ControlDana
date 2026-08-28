# Безопасность

Источник истины для доступа — серверная сессия и `RegistryAccessScope`, не роль/userId из тела запроса и не клиентская фильтрация.

## Обязательные правила этого этапа

- CSRF на mutation-запросах, `mustChangePassword` блокирует остальной API
- cookie сессии: idle 12 часов, absolute 7 дней, SameSite=Lax, Secure в production
- Helmet CSP на JSON API (`default-src 'none'`); Next.js CSP с `frame-ancestors 'none'` и без `unsafe-eval` в production
- инструментальный аудит 2026-08-28: [SECURITY_AUDIT_2026-08-28.md](../security/SECURITY_AUDIT_2026-08-28.md)
- capability проверяется на сервере
- вне scope запись уведомления неотличима от отсутствия (404)
- HTML писем экранируется, subject без CRLF
- секреты (SMTP password, MinIO, session, CSRF, B/C) не попадают в payload уведомлений, email, hydration, audit detail и client bundle
- `PUBLIC_APP_URL` задаётся конфигурацией; Host входящего запроса не используется для ссылок
- SMTP host/port только из env, без SSRF через пользовательский ввод
- rate limit на notification mutations
- bounded JSON payload, Decimal/Date сериализация на сервере
- select вместо отдачи Prisma-моделей
- open redirect запрещён: ссылки писем ведут только на `/acts/:id`

B/C коммерческие поля не возвращаются RESPONSIBLE_ENGINEER ни в одном канале.
