# Ротация Redis credentials

Production Redis всегда требует ACL (`sgr_api`, `sgr_worker`). Пароли не хранятся в Git, compose command line и `/api/ready`.

## Принципы

- Runtime-процессы не используют `default` user.
- API подключается как `sgr_api` (`REDIS_URL`), worker — как `sgr_worker` (`WORKER_REDIS_URL`).
- Пароли читаются из secret store / Docker secrets (`REDIS_API_PASSWORD_FILE`, `REDIS_WORKER_PASSWORD_FILE`).
- После ротации старый пароль должен перестать работать.

## Порядок

1. Выпустить новые пароли в secret store. Не печатать значения и не коммитить их.
2. На Redis-хосте обновить secret files и перезапустить контейнер Redis (entrypoint пересчитает SHA-256 ACL). `protected-mode yes` и отсутствие publish портов не меняются.
3. Обновить `REDIS_URL` / `WORKER_REDIS_URL` в runtime secret (username без изменений).
4. Перезапустить API, затем worker, чтобы они открыли новые соединения.
5. Проверить `GET /api/ready` (без URL/пароля в JSON) и worker `/health`.
6. Подтвердить, что соединение со старым паролем получает отказ (`WRONGPASS` / `invalid username-password`).
7. Удалить старый secret из store после успешного входа сессий и обработки очереди BullMQ.

## Откат

Вернуть предыдущие secret files и runtime URL, перезапустить Redis → API → worker. Не включать `default` user и не публиковать порт Redis на `0.0.0.0`.

## Локальная разработка

`.env.example` содержит вымышленный `REDIS_PASSWORD=local-development-only`. Это значение запрещено в production (`loadConfig` завершает запуск). Локальный compose читает пароли из gitignored `infra/docker/secrets/*` (`pnpm infra:up` синхронизирует файлы из `.env`).
