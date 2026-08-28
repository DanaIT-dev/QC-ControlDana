# Архитектура

## Компоненты

Монорепозиторий pnpm workspace:

- `apps/web` — Next.js 16, React 19, App Router. Вход, смена пароля, реестр, создание и карточка акта, центр уведомлений, контроль сроков, справочники, пользователи, system-status. Защита маршрутов через `proxy.ts` (не deprecated `middleware`).
- `apps/api` — NestJS 11 на Fastify. HTTP API, сессии Redis, CSRF, capability matrix, команды актов/дефектов, уведомления, SLA, outbox dispatcher, справочники, пользователи, реестр, health/ready.
- `apps/worker` — NestJS application context без HTTP. Очереди BullMQ `sgr-maintenance`, `sgr-attachments` и `sgr-notifications`.
- `packages/domain` — чистые типы, инварианты и доменные функции. Без React и Prisma.
- `packages/database` — Prisma schema, клиент, миграции, seed, генерация номера акта.
- `packages/config` — типобезопасная конфигурация окружения (Zod).
- `packages/contracts` — общие DTO и перечисления без зависимости от UI.
- `packages/typescript-config`, `packages/eslint-config` — общее качество кода.

Локальная инфраструктура в `infra/docker/compose.yaml`: PostgreSQL 18, Redis, MinIO, ClamAV, Mailpit.

## Границы модулей и зависимости

Направление зависимостей только внутрь:

```
web → contracts, domain
api → config, contracts, database, domain
worker → config, database, domain
database → domain
domain → contracts
config → (нет внутренних пакетов)
```

Доменная логика не размещается в React-компонентах. Prisma Client создаётся только в `packages/database` (`createPrismaClient` / `getPrismaClient`).

## Почему модульный монолит

На текущем этапе одна команда, одна транзакционная модель и одна база. Разделение на процессы web/api/worker даёт независимый запуск и масштабирование фоновых задач, но не требует сети микросервисов, отдельных БД или брокера событий. Event sourcing и Kubernetes сознательно не используются.

## Локальная инфраструктура

Docker Compose поднимает:

- PostgreSQL 18 с named volume и отдельной test-базой `sgr_registry_test`;
- Redis для сессий, ограничения перебора пароля, очередей и проверки готовности;
- MinIO как приватное S3-совместимое хранилище вложений;
- ClamAV (`clamd` на localhost:3310) для антивирусной проверки перед статусом READY; образ закреплён по digest, index включает `linux/arm64`.
- Mailpit (SMTP 127.0.0.1:1025, UI 127.0.0.1:8025) только для development/test; образ закреплён по digest, index включает `linux/arm64`. Production SMTP задаётся env.

Порты задаются переменными окружения. Первый запуск ClamAV качает сигнатуры и может занять несколько минут. Демонстрационные пароли только для local development.

Тестовый bucket `sgr-attachments-test` и база `*_test` отделены от development. Integration-тесты отказываются работать с bucket без суффикса `-test`.

## Уведомления и контроль сроков

Доменные мутации пишут `OutboxEvent` в той же транзакции PostgreSQL. Email уходит только из worker/API processor (BullMQ), не из HTTP mutation. Проекция идемпотентна по `occurrenceKey`. Доставка at-least-once, не exactly-once. SMTP outage не делает `/api/ready` недоступным.

Экран «Контроль сроков» (`/deadlines`) читает `SlaClock` в `RegistryAccessScope`. Состояние считает сервер в `Europe/Minsk`.

## Будущая интеграция с 1С

Интеграция с 1С не входит в текущую версию: нет импорта, синхронизации и внешнего API 1С.

Когда она появится, её следует подключать адаптером на границе `apps/api` или `apps/worker`, который отображает внешние документы на уже существующие доменные сущности (`Act`, `DefectItem`, `Organization`). Доменная модель не должна получать поля «1С» или знать протокол обмена. Конфликты и идемпотентность импорта остаются в антикоррупционном слое, а не в `packages/domain`.

## Операционные команды

Мутации идут через command-specific DTO со strict whitelist, не через generic PATCH. Цепочка: сессия → mustChangePassword → CSRF → capability → RegistryAccessScope → валидация → инвариант → optimistic concurrency → transaction + AuditLog → safe serializer.

Идемпотентность создания акта хранится в `idempotency_records` с уникальным ключом `(actorUserId, command, idempotencyKey)`.

## Реестр DefectItem

Список, count, summary, filter-options и карточка акта используют один `RegistryAccessScope`. Условие доступа входит в Prisma `where`; это прикладной scope, а не PostgreSQL RLS. Коммерческие поля B/C формируются role-aware serializer на сервере и не маскируются на клиенте. Пагинация выполняется в PostgreSQL (`skip`/`take`). Для сортировки по `effectiveDeadline` используется generated stored column `COALESCE(claimDeadline, plannedDeadline)`.
