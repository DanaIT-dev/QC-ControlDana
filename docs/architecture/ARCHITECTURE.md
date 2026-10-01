# Архитектура

## Компоненты

Монорепозиторий pnpm workspace:

- `apps/web` — Next.js 16, React 19, App Router. Вход, смена пароля, реестр, создание и карточка акта (включая внутреннее обсуждение), центр уведомлений, контроль сроков, справочники, пользователи, изолированный экран `/super-admin`, system-status. Защита маршрутов через `proxy.ts` (не deprecated `middleware`).
- `apps/api` — NestJS 11 на Fastify. HTTP API, сессии Redis, CSRF, capability matrix, команды актов/дефектов, read API уведомлений и SLA, создание OutboxEvent, справочники, пользователи, назначение ADMIN суперадминистратором, реестр, health/ready. HTTP-процесс не claim outbox, не отправляет email и не регистрирует BullMQ processors.
- `apps/worker` — отдельный runtime без продуктового HTTP-порта (liveness на `127.0.0.1:WORKER_HEALTH_PORT`). Outbox dispatcher, проекция уведомлений, email, SLA scheduler/evaluator, scan вложений, retry/DEAD, catch-up, heartbeat в Redis.
- `packages/domain` — чистые типы, инварианты и доменные функции. Без React и Prisma.
- `packages/database` — Prisma schema, клиент, миграции, seed, генерация номера акта.
- `packages/jobs` — общий dispatcher, OutboxWriter, heartbeat и ops-сбор без HTTP. Импортируется API (producer) и worker (consumer); бизнес-логика не копируется.
- `packages/config` — типобезопасная конфигурация окружения (Zod).
- `packages/contracts` — общие DTO и перечисления без зависимости от UI.
- `packages/typescript-config`, `packages/eslint-config` — общее качество кода.

Локальная инфраструктура в `infra/docker/compose.yaml`: PostgreSQL 18, Redis 7 с ACL, объектное хранилище SeaweedFS, ClamAV, Mailpit. Production-манифест `infra/docker/compose.production.yaml` публикует только reverse proxy; PostgreSQL, Redis, объектное хранилище и ClamAV остаются во внутренней сети.

## Границы модулей и зависимости

Направление зависимостей только внутрь:

```
web → contracts, domain
api → config, contracts, database, domain, jobs
worker → config, database, domain, jobs
jobs → config, contracts, database, domain
database → domain
domain → contracts
config → (нет внутренних пакетов)
```

Доменная логика не размещается в React-компонентах. Prisma Client создаётся только в `packages/database` (`createPrismaClient` / `getPrismaClient`).

## Почему модульный монолит

На текущем этапе одна команда, одна транзакционная модель и одна база. Разделение на процессы web/api/worker даёт независимый запуск и масштабирование фоновых задач, но не требует сети микросервисов, отдельных БД или брокера событий. Event sourcing и Kubernetes сознательно не используются.

## Локальная инфраструктура

Docker Compose поднимает:

- PostgreSQL 18 с named volume, development-базой `sgr_registry`, integration-базой `sgr_registry_test` и Playwright-базой `sgr_registry_e2e`;

- Redis для сессий, ограничения перебора пароля, очередей и проверки готовности (локально и в production — с ACL AUTH; production не публикует порт Redis);
- PostgreSQL: `sgr_app` не читает `user_credentials.passwordHash`; login/смена пароля идут через `sgr_auth`;
- MinIO как приватное S3-совместимое хранилище вложений;
- ClamAV (`clamd` на localhost:3310) для антивирусной проверки перед статусом READY; образ закреплён по digest, index включает `linux/arm64`.
- Mailpit (SMTP 127.0.0.1:1025, UI 127.0.0.1:8025) только для development/test; образ закреплён по digest, index включает `linux/arm64`. Production SMTP задаётся env.

Порты инфраструктуры публикуются только на loopback (`127.0.0.1:HOST:CONTAINER`). Приложения внутри Docker ходят по service names, процессы на host — через localhost. Mailpit UI/SMTP и ClamAV также только на localhost.

Тестовый bucket `sgr-attachments-test` и база `*_test` отделены от development. Integration-тесты отказываются работать с bucket без суффикса `-test`. Playwright использует `sgr-attachments-e2e` и `sgr_registry_e2e`.

## Уведомления и контроль сроков

Доменные мутации пишут `OutboxEvent` в той же транзакции PostgreSQL. Email и claim outbox выполняет только отдельный worker (BullMQ), не HTTP API. Проекция идемпотентна по `occurrenceKey`. Доставка **at-least-once**, не exactly-once: SMTP выполняется **вне** DB-транзакции после короткого claim/lease; finalize — отдельная короткая worker-транзакция. Повтор после crash между успешным SMTP и finalize использует тот же детерминированный `Message-ID`. SMTP outage и остановка worker не делают `/api/ready` недоступным. System Status показывает heartbeat worker (`up`/`down` по Redis TTL). PWA Push — следующий отдельный этап, в этой версии не реализуется.

Экран «Контроль сроков» (`/deadlines`) читает `SlaClock` в `RegistryAccessScope`. Состояние считает сервер в `Europe/Minsk`.

## Создание актов

Акты создаются только вручную (`CREATE_ACT` у ADMIN, SGR_MANAGER и RESPONSIBLE_ENGINEER на закреплённых активных объектах). Интеграция с 1С исключена из проекта и не является каналом поступления данных.

## Доступ к реестру и PostgreSQL RLS

Список, count, summary, filter-options и карточка акта используют прикладной `RegistryAccessScope` (Guards, capabilities, Prisma `where`) и второй уровень — PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`, verified HMAC-контекст, отдельные runtime-роли). Коммерческие поля B/C скрываются и serializer’ом, и row policy / slot predicate: RESPONSIBLE_ENGINEER не читает B/C даже прямым SQL под `sgr_app`. Пагинация выполняется в PostgreSQL (`skip`/`take`). Для сортировки по `effectiveDeadline` используется generated stored column `COALESCE(claimDeadline, plannedDeadline)`.

Роли БД, provisioning и rotation секрета: [RLS_OPERATIONS.md](../security/RLS_OPERATIONS.md), матрица: [RLS_POLICY_MATRIX.md](../security/RLS_POLICY_MATRIX.md). `SUPER_ADMIN` не входит в `sgr_is_staff()` / `sgr_is_admin()`: SELECT бизнес-таблиц через `sgr_is_super_admin()`, прямые INSERT/UPDATE/DELETE запрещены. Узкие SECURITY DEFINER: `sgr_grant_admin` / `sgr_revoke_admin` / `sgr_create_pending_user`. Учётка SUPER_ADMIN создаётся командой `pnpm super-admin:provision` (одна транзакция, TTY-пароль).

Интерактивная Prisma-транзакция запроса держит одно PostgreSQL-соединение. Параллельный `Promise.all` и вложенные `include` сериализуются на этом client (не глобальным mutex): иначе `pg@9` отвергнет второй `client.query()`. Разные HTTP-запросы по-прежнему параллельны на разных соединениях пула. RLS-контекст transaction-local; после commit/rollback client не покидает транзакцию и не переносится в ALS.

## Внутренний чат акта

Карточка акта содержит вкладку «Обсуждение» для `ADMIN`, `SGR_MANAGER`, `RESPONSIBLE_ENGINEER` и read-only для `SUPER_ADMIN` (последнему ответственному — только закреплённые объекты). `CONTRACTOR_ENGINEER` не видит UI и получает `403` на API. Сообщения — plain text, без редактирования, удаления и вложений. `@` создаёт только внутреннее уведомление `ACT_CHAT_MENTION` (без SMTP, SMS, Telegram и Web Push). Упоминание не расширяет доступ к акту. Пагинация keyset, обновление — polling открытой вкладки, без WebSocket. `SUPER_ADMIN` не отправляет сообщения.

Worker не имеет GRANT на таблицы чата и не читает содержимое переписки.

Worker не держит эту транзакцию на время SMTP, DNS, TLS, MinIO, ClamAV или Redis.

## Операционные команды

Мутации идут через command-specific DTO со strict whitelist, не через generic PATCH. Цепочка: сессия → mustChangePassword → CSRF → capability → RegistryAccessScope → валидация → инвариант → optimistic concurrency → transaction + AuditLog → safe serializer.

Идемпотентность создания акта хранится в `idempotency_records` с уникальным ключом `(actorUserId, command, idempotencyKey)`.
