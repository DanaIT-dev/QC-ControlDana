# Объектное хранилище

Активный сервер — RustFS 1.0.0, образ `rustfs/rustfs:1.0.0`.

```text
manifest list: sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff
linux/amd64:   sha256:ba0a1b53e36f321c0d46f3867104abef169f7bc59c467c664ddac87e7ddc9a8b
linux/arm64:   sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b
```

Источник: `https://github.com/rustfs/rustfs`, релиз `1.0.0` от 2026-09-16. Лицензия исходников — Apache-2.0. Образ запускается пользователем `rustfs` (uid 10001). Консоль не публикуется. Compose задаёт `RUSTFS_CONSOLE_ENABLE=false`.

Клиент приложения — один адаптер `packages/database/src/object-storage.ts` на AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`). API и worker реэкспортируют его. Отдельного MinIO SDK нет.

## Переменные

Канонические имена: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_USE_SSL`, `S3_PRESIGNED_TTL_SECONDS`, `S3_MULTIPART_THRESHOLD_BYTES`.

`S3_ACCESS_KEY` и `S3_SECRET_KEY` принимаются только вне production. Если заданы только они, процесс пишет предупреждение без значения секрета. Если оба набора заданы и различаются, конфигурация отвергается. В production допустимы только `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY`. Алиасы удаляются после 2026-12-31.

`S3_PRESIGNED_TTL_SECONDS` не создаёт подписанный URL: продукт не использует presigned-операции.

## Сеть и процесс

Production и staging не публикуют порт хранилища и не публикуют консоль. Доступ есть только из внутренней сети compose. Локальный compose публикует API на `127.0.0.1`. Учётные данные production читаются из файлов секретов `RUSTFS_ACCESS_KEY_FILE` и `RUSTFS_SECRET_KEY_FILE`. В compose нет значения секрета.

Контейнер: `no-new-privileges`, `cap_drop: ALL`, лимит процессов, лимит памяти, `restart: unless-stopped`, healthcheck `GET /health`. Официальный образ уже задаёт пользователя `rustfs`; uid в compose не переопределяется.

Данные лежат в именованном volume. Старые volume `sgr_registry_minio`, `sgr_minio` и `sgr_staging_minio` остаются объявленными и не смонтированы.

## Наблюдение

Readiness-компонент называется `objectStorage`. Проверка — `HeadBucket` с timeout 5 секунд. Она не создаёт bucket и не пишет объект. Создание bucket остаётся на старте модуля вложений.

Alert `ObjectStorageUnavailable` смотрит `sgr_component_up{component="objectStorage"}`. Задержка видна в `latencyMs` readiness. Ошибки загрузки и удаления остаются в статусе вложения и логах без ключа секрета, без presigned URL и без содержимого файла. Возраст backup читается из manifest backup. Незавершённые multipart прерываются адаптером при ошибке `Upload`.

## Телеметрия

Entrypoint RustFS 1.0.0 пишет локальный журнал в каталог логов. Compose не задаёт внешний адрес телеметрии и не задаёт `RUSTFS_OBS_LOG_DIRECTORY` на URL.
