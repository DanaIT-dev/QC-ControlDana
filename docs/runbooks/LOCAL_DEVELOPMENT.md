# Локальная разработка

## Подготовка

1. Установить Node.js 24 (`nvm use` или эквивалент по `.nvmrc`).
2. Включить pnpm через Corepack: `corepack enable && corepack prepare pnpm@11.24.0 --activate`. Если `pnpm` нет в `PATH`, используйте `corepack pnpm` или `~/.local/bin/pnpm`.
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
Экран входа: http://localhost:3000/login

Демо-учётки и локальный пароль описаны в [AUTHENTICATION.md](../requirements/AUTHENTICATION.md). `SEED_DEMO_PASSWORD` задаётся только в `.env` и не коммитится.

## Тесты

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:registry:performance
```

`pnpm test:registry:performance` создаёт ≥ 100 000 строк только в `sgr_registry_test`, снимает `EXPLAIN ANALYZE` типового list-запроса и удаляет performance-данные. Development-база не используется.

Integration-тесты требуют `TEST_DATABASE_URL` с именем базы, оканчивающимся на `_test`. Если URL отсутствует или указывает на development/production базу, команда завершается с ошибкой и не пропускает тесты.

## Качество

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```
