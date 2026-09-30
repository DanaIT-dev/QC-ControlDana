# Backup и restore объектного хранилища

Development volume в этом drill не участвует. Drill выполняется на disposable volume.

## Что сохраняется

1. Набор объектов с известными SHA-256, `Content-Type` и размером.
2. Каталог данных контейнера (`/data` у RustFS).
3. Manifest backup приложения, если backup собирает `packages/database`: он шифруется AES-256-GCM ключом из `BACKUP_ENCRYPTION_KEY_FILE` и включает компонент `object-storage`.

Ключ шифрования и учётные данные в Git не записываются.

## Порядок disposable drill

1. Поднять отдельный контейнер RustFS с новым volume и отдельным bucket. Не монтировать `sgr_registry_minio`.
2. Загрузить фиксированный набор объектов через S3 API.
3. Сохранить список ключей, размеров, `Content-Type` и SHA-256 вне контейнера.
4. Остановить контейнер.
5. Скопировать `/data` из остановленного контейнера.
6. Удалить только disposable volume.
7. Создать новый volume, вернуть копию `/data`, выставить владельца `10001:10001`.
8. Запустить тот же образ `rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`.
9. Прочитать каждый объект, сравнить размер и SHA-256, убедиться, что лишних объектов нет.

Прогон 2026-09-30 на disposable RustFS: mismatches 0, extra objects 0. Тот же порядок прошёл на reference MinIO и на SeaweedFS 4.48 до выбора провайдера.

## Restore приложения

`packages/database` читает зашифрованный backup и записывает объекты через тот же S3-адаптер. Источник production этим документом не изменяется. Удаление исходного volume после restore этим runbook не разрешено.
