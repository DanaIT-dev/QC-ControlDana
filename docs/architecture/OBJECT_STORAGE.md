# Объектное хранилище

Активный сервер для development и staging — официальный SeaweedFS 4.48, образ `chrislusf/seaweedfs:4.48`.

```text
manifest list: sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d
linux/amd64:   sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931
```

Источник: `https://github.com/seaweedfs/seaweedfs`, релиз `4.48`. Лицензия — Apache-2.0. Сервер после старта работает как uid 1000. Наружу публикуется только S3-порт. Порты master, filer и admin не публикуются. RustFS 1.0.0 в пилот не допускается. Development, staging и production compose используют SeaweedFS. Production не публикует object storage наружу и не считается production-ready.

Клиент приложения — один адаптер `packages/database/src/object-storage.ts` на AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`). API и worker реэкспортируют его. Отдельного MinIO SDK нет.

## Переменные

Канонические имена: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_USE_SSL`, `S3_PRESIGNED_TTL_SECONDS`, `S3_MULTIPART_THRESHOLD_BYTES`.

`S3_ACCESS_KEY` и `S3_SECRET_KEY` принимаются только вне production. Если заданы только они, процесс пишет предупреждение без значения секрета. Если оба набора заданы и различаются, конфигурация отвергается. В production допустимы только `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY`. Алиасы удаляются после 2026-12-31.

`S3_PRESIGNED_TTL_SECONDS` не создаёт подписанный URL: продукт не использует presigned-операции.

## Сеть и процесс

Staging не публикует порт хранилища. Доступ есть только из внутренней сети compose. Локальный compose публикует S3 на `127.0.0.1`. Учётные данные читаются из `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` или из файлов `S3_ACCESS_KEY_FILE` / `S3_SECRET_KEY_FILE`. В compose нет значения секрета.

Контейнер: `no-new-privileges`, лимит процессов, лимит памяти, `restart: unless-stopped`, healthcheck внутреннего master `GET /cluster/status`. `cap_drop: ALL` не задан: официальный entrypoint коротко работает от root, чтобы сменить владельца `/data`, и затем переводит сервер на uid 1000. Снятые capabilities ломают этот переход.

Данные development лежат в новом volume `sgr_registry_seaweedfs`. Volume RustFS `sgr_registry_object_storage` и legacy MinIO volume остаются объявленными и не смонтированы. Их нельзя удалять.

## Наблюдение

Readiness-компонент называется `objectStorage`. Проверка — `HeadBucket` с timeout 5 секунд. Она не создаёт bucket и не пишет объект. Создание bucket остаётся на старте модуля вложений.

Alert `ObjectStorageUnavailable` смотрит `sgr_component_up{component="objectStorage"}`. Задержка видна в `latencyMs` readiness. Ошибки загрузки и удаления остаются в статусе вложения и логах без ключа секрета, без presigned URL и без содержимого файла. Возраст backup читается из manifest backup. Незавершённые multipart прерываются адаптером при ошибке `Upload`.

## Телеметрия

Команда SeaweedFS задаёт `-master.telemetry=false`. Внешний адрес телеметрии не передаётся.
