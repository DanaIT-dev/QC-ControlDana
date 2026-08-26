# Локальная разработка

## Подготовка

1. Установить Node.js 24 (`nvm use` или эквивалент по `.nvmrc`).
2. Включить pnpm через Corepack: `corepack enable && corepack prepare pnpm@11.24.0 --activate`.
3. Скопировать `.env.example` в `.env`.
4. Установить зависимости: `pnpm install`.
5. Сгенерировать Prisma Client: `pnpm db:generate`.

## Инфраструктура

```bash
docker compose -f infra/docker/compose.yaml --env-file .env up -d
pnpm db:migrate
pnpm db:seed
```

Остановка:

```bash
docker compose -f infra/docker/compose.yaml --env-file .env down
```

## Приложения

```bash
pnpm dev
```

Проверки:

```bash
curl -i http://localhost:3001/api/health
curl -i http://localhost:3001/api/ready
```

Главная страница web: http://localhost:3000

## Тесты

```bash
pnpm test
pnpm test:integration
```

Integration-тесты требуют `TEST_DATABASE_URL` с именем базы, оканчивающимся на `_test`. Если URL отсутствует или указывает на development/production базу, команда завершается с ошибкой и не пропускает тесты.

## Качество

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```
