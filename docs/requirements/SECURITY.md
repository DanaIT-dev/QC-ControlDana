# Безопасность

Источник истины для доступа — серверная сессия и `RegistryAccessScope`, не роль/userId из тела запроса и не клиентская фильтрация.

## Обязательные правила этого этапа

- CSRF на mutation-запросах, `mustChangePassword` блокирует остальной API
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
