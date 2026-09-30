# Первый запуск и откат

Этот runbook не заменяет разрешение на выкладку. Команды ниже выполняются на будущем production-хосте, не на development-базе `sgr_registry`.

## До релиза

1. `git rev-parse HEAD` совпадает с проверенным commit, `git status --short` пустой.
2. `SGR_IMAGE_TAG` равен `git rev-parse HEAD`. `SGR_RUNTIME_IMAGE_DIGEST`, `SGR_WEB_IMAGE_DIGEST` и `SGR_MIGRATOR_IMAGE_DIGEST` — immutable `sha256`. `latest` не используется.
3. `pnpm ops:production-compose` проходит.
4. `infra/docker/secrets/app.env` заполнен. `pnpm ops:readiness` проходит и не печатает значения.
5. Есть свежий зашифрованный backup и проверенный restore drill на изолированных ресурсах.
6. На диске достаточно места под данные, логи и отдельный `BACKUP_ROOT`.
7. SMTP принимает тестовое письмо на внутренний ящик.
8. DNS указывает на proxy, TLS-файлы смонтированы в `infra/docker/secrets/tls`.
9. Записаны текущие количества пользователей, ролей, объектов, актов, дефектов, назначений и unresolved references.

## Релиз

1. Включить maintenance page на proxy, если пользователи уже работают.
2. Снять backup и сверить SHA-256.
3. Применить миграции отдельным шагом: `docker compose -f infra/docker/compose.production.yaml --profile migrate run --rm migrator`.
4. Запустить immutable images: `docker compose -f infra/docker/compose.production.yaml up -d`.
5. Дождаться healthcheck proxy, API ready и worker heartbeat.
6. Выполнить smoke: login, registry, один read-only запрос акта, system-status.
7. Отправить одно тестовое уведомление и убедиться, что outbox ушёл.
8. Выключить maintenance.

Seed и `prisma migrate reset` в production запрещены. `NODE_ENV=production` завершает seed ошибкой до подключения к базе.

## Postcheck

Сверить HEAD и image tag, статус миграций, пользователей и роли, объекты, акты, дефекты, назначения, unresolved references, последнюю запись AuditLog, число объектов MinIO, `/api/health`, `/api/ready` и расписание backup.

## Откат

Application rollback: вернуть предыдущие digest API, web и migrator, если миграция не меняла данные, которые новый код уже записал, и схема совместима со старым образом. Плавающий tag для отката не используется.

Database restore: остановить API и worker, восстановить PostgreSQL и MinIO из backup на чистые тома, затем запустить прежний image. Это нужно, когда миграция уже изменила production-данные или откат образа не поднимает readiness.

Import batch rollback: только для выбранного batch, только вне production, только на test/e2e базе. Development batch `20aead92-33c4-4606-8612-9dad28537639` не удаляется этим runbook.
