# Локальная разработка

## Подготовка

1. Установить Node.js 24 (`nvm use` или эквивалент по `.nvmrc`).
2. Включить pnpm через Corepack: `corepack enable && corepack prepare pnpm@11.24.0 --activate`. Если `pnpm` нет в `PATH`, используйте `corepack pnpm` или `~/.local/bin/pnpm`.
3. Скопировать `.env.example` в `.env`. Локальный Redis требует AUTH (`REDIS_PASSWORD=local-development-only` — вымышленное значение; в production запрещено). `pnpm infra:up` записывает gitignored Docker secret files и не кладёт пароль в environment контейнера.
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
pnpm infra:up
pnpm db:roles:provision
pnpm db:migrate
# также примените миграции к test-базе (тот же migrator URL с именем *_test)
# Playwright сам создаёт и удаляет sgr_registry_e2e; development не reset-ьте
pnpm db:seed
# SUPER_ADMIN не входит в seed. Локальное создание:
# SGR_SUPER_ADMIN_PROVISION_CONFIRM=<имя БД> pnpm super-admin:provision
```

Исторический реестр дефектных актов импортируется отдельно, без seed/reset development-базы. Excel не коммитится. Dry-run по умолчанию; запись только с подтверждением имени БД. Контракт: [LEGACY_ACTS_IMPORT.md](../requirements/LEGACY_ACTS_IMPORT.md).

```bash
pnpm acts:import -- --file="/absolute/path/to.xlsx" --dry-run --expect-sha256=<sha256>
```

Двухсловное ФИО не разбирается автоматически. Подтверждённая коррекция структуры (без смены пароля и sessionVersion):

```bash
pnpm --filter @sgr-registry/database users:correct-name -- --user-id=<uuid> --last-name=<Фамилия> --first-name=<Имя> --confirm-database=sgr_registry
```

Не используйте bootstrap `sgr_registry` в `DATABASE_URL` / `AUTH_DATABASE_URL` / `WORKER_DATABASE_URL`. Seed и migrate — `MIGRATION_DATABASE_URL`. Development-базу не reset-ьте ради RLS.

Внутренний чат акта не требует SMTP: Mailpit можно не открывать, чтобы проверить `@` упоминания. Worker по-прежнему нужен для остальных уведомлений и SLA.

Порты PostgreSQL, Redis, объектного хранилища, Mailpit и ClamAV публикуются только на `127.0.0.1`. Redis локально требует ACL. Production-шаблон не публикует Redis. Проверка:

```bash
node scripts/security/check-docker-exposure.mjs
node scripts/security/validate-production-compose.mjs
```

Инструментальный SAST/DAST описан в [SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md). Команды:

```bash
bash scripts/security/run-sast.sh
# изолированная disposable-БД, Redis /15, отдельный MinIO bucket, loopback-only:
bash scripts/security/run-isolated-dast.sh
```

Отчёты пишутся в gitignored `test-results/security-audit/`. Не коммитить scanner cache и сырые отчёты.

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

Демо-учётки и локальный пароль описаны в [AUTHENTICATION.md](../requirements/AUTHENTICATION.md). `SEED_DEMO_PASSWORD` задаётся только в `.env` и не коммитится. `SUPER_ADMIN` создаётся только `pnpm super-admin:provision`: пароль вводится masked TTY (8–128 символов), не аргументом CLI, не через `.env` и не из файла. Для базы без суффикса `_test` и для `NODE_ENV=production` нужно `SGR_SUPER_ADMIN_PROVISION_CONFIRM` равное имени целевой БД. Проверка существующего SUPER_ADMIN идёт через `sgr_active_super_admins()` (owner/migrator), чтобы RLS не дал ложный «записи нет». Создание, credentials, Argon2id-хеш, `sessionVersion` и `SUPER_ADMIN_PROVISIONED` выполняются в одной транзакции с advisory lock. `--replace` атомарно архивирует только подтверждённый email (повторный ввод email в TTY); при ошибке откатывается всё, включая прежнюю активную запись. Redis-сессии заменённой учётки отзываются только после commit. По умолчанию активен один SUPER_ADMIN.

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

Development-база `sgr_registry` не является тестовой. Integration-тесты требуют `TEST_DATABASE_URL` с именем `*_test` (`sgr_registry_test`). Playwright/`pnpm test:e2e` работает только с `sgr_registry_e2e` (Redis logical DB 14, prefix `sgr-e2e`, MinIO `sgr-attachments-e2e`, порты 3200/3201/3202). Параллельный запуск integration и Playwright не пересекается по БД, Redis namespace и bucket. Fixture-скрипты завершаются ошибкой до записи, если цель не `sgr_registry_e2e`. После прогона синтетические данные удаляются только из E2E-среды; development не очищается.

Если URL отсутствует или указывает на development/production базу, integration-команда завершается с ошибкой и не пропускает тесты.

Playwright: [e2e README](../../apps/web/e2e/README.md). `reuseExistingServer` выключен: suite не подключается к `pnpm dev`.

## Качество

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
```
