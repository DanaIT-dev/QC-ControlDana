# Локальная разработка

## Подготовка

1. Установить Node.js 24 (`nvm use` или эквивалент по `.nvmrc`).
2. Включить pnpm через Corepack: `corepack enable && corepack prepare pnpm@11.24.0 --activate`. Если `pnpm` нет в `PATH`, используйте `corepack pnpm` или `~/.local/bin/pnpm`.
3. Скопировать `.env.example` в `.env`.
4. Установить зависимости: `pnpm install`.
5. Сгенерировать Prisma Client: `pnpm db:generate`.

## Инфраструктура

Первый запуск ClamAV качает сигнатуры (часто 1–3 минуты). `GET /api/ready` остаётся `not_ready`, пока `clamav` не ответит PONG. Production object storage должен быть с TLS и полностью приватным bucket.

Образ ClamAV закреплён по immutable digest в `infra/docker/compose.yaml` (`clamav/clamav-debian:1.4@sha256:…`). Это index digest тега `1.4`, в нём есть `linux/arm64`. Плавающий тег без digest не используется.

Обновление digest после проверки нового образа `1.4`:

```bash
docker pull clamav/clamav-debian:1.4
docker image inspect clamav/clamav-debian:1.4 --format '{{index .RepoDigests 0}}'
docker compose -f infra/docker/compose.yaml --env-file .env up -d --force-recreate clamav
```

Подставьте полученный `sha256:…` в `image:` Compose (формат `clamav/clamav-debian:1.4@sha256:…`) и пересоздайте сервис командой выше.

Образ Mailpit закреплён по immutable digest (`axllent/mailpit:v1.27.10@sha256:…`). UI/SMTP только на localhost (`127.0.0.1`). Обновление digest:

```bash
docker pull axllent/mailpit:v1.27.10
docker image inspect axllent/mailpit:v1.27.10 --format '{{index .RepoDigests 0}}'
docker compose -f infra/docker/compose.yaml --env-file .env up -d --force-recreate mailpit
```

```bash
docker compose -f infra/docker/compose.yaml --env-file .env up -d
pnpm db:roles:provision
pnpm db:migrate
# также примените миграции к test-базе (тот же migrator URL с именем *_test)
pnpm db:seed
```

Не используйте bootstrap `sgr_registry` в `DATABASE_URL` / `AUTH_DATABASE_URL` / `WORKER_DATABASE_URL`. Seed и migrate — `MIGRATION_DATABASE_URL`. Development-базу не reset-ьте ради RLS.

Внутренний чат акта не требует SMTP: Mailpit можно не открывать, чтобы проверить `@` упоминания. Worker по-прежнему нужен для остальных уведомлений и SLA.

Порты PostgreSQL, Redis, MinIO, Mailpit и ClamAV публикуются только на `127.0.0.1`. Проверка:

```bash
node scripts/security/check-docker-exposure.mjs
```

Инструментальный SAST/DAST (Semgrep, Gitleaks, pnpm audit, Trivy, OWASP ZAP) описан в [SECURITY_AUDIT_2026-08-28.md](../security/SECURITY_AUDIT_2026-08-28.md). Команды:

```bash
bash scripts/security/run-sast.sh
# при запущенных web/api/worker на localhost:
bash scripts/security/run-dast.sh
```

Отчёты пишутся в gitignored `test-results/security/`. Не коммитить scanner cache и сырые отчёты.

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
curl -i http://127.0.0.1:3002/health
```

Worker: outbox claim и email finalize — короткие RLS-транзакции с `sgr_set_worker_context`. SMTP (`SMTP_TIMEOUT_MS`, по умолчанию 8000) вне PostgreSQL; сокет закрывается через `destroy`, чтобы не копить `CLOSE_WAIT` на Docker Desktop. PWA Push не включается на этом этапе. Акты создаются только вручную; 1С исключена.

Главная страница web: http://localhost:3000  
Экран входа: http://localhost:3000/login

Демо-учётки и локальный пароль описаны в [AUTHENTICATION.md](../requirements/AUTHENTICATION.md). `SEED_DEMO_PASSWORD` задаётся только в `.env` и не коммитится.

## Тесты

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:attachments:stream
pnpm test:registry:performance
pnpm test:sla:performance
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
