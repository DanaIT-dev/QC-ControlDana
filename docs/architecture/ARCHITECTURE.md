# Архитектура

## Компоненты

Монорепозиторий pnpm workspace:

- `apps/web` — Next.js 16, React 19, App Router. Вход, защищённый реестр-заглушка, system-status для ADMIN.
- `apps/api` — NestJS 11 на Fastify. HTTP API, сессии Redis, RBAC, health/ready, requestId, безопасный обработчик ошибок.
- `apps/worker` — NestJS application context без HTTP. BullMQ-очередь `sgr-maintenance`.
- `packages/domain` — чистые типы, инварианты и доменные функции. Без React и Prisma.
- `packages/database` — Prisma schema, клиент, миграции, seed, генерация номера акта.
- `packages/config` — типобезопасная конфигурация окружения (Zod).
- `packages/contracts` — общие DTO и перечисления без зависимости от UI.
- `packages/typescript-config`, `packages/eslint-config` — общее качество кода.

Локальная инфраструктура в `infra/docker/compose.yaml`: PostgreSQL 18, Redis, MinIO.

## Границы модулей и зависимости

Направление зависимостей только внутрь:

```
web → contracts, domain
api → config, contracts, database, domain
worker → config
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
- MinIO как S3-совместимое хранилище (загрузка файлов — следующий этап).

Порты задаются переменными окружения. Демонстрационные пароли только для local development.

## Будущая интеграция с 1С

Интеграция с 1С не входит в текущую версию: нет импорта, синхронизации и внешнего API 1С.

Когда она появится, её следует подключать адаптером на границе `apps/api` или `apps/worker`, который отображает внешние документы на уже существующие доменные сущности (`Act`, `DefectItem`, `Organization`). Доменная модель не должна получать поля «1С» или знать протокол обмена. Конфликты и идемпотентность импорта остаются в антикоррупционном слое, а не в `packages/domain`.
