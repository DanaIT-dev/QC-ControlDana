# Backup и restore объектного хранилища

Development volume в этом drill не участвует. Drill выполняется на disposable volume.

## Что сохраняется

1. Набор объектов с известными SHA-256, `Content-Type` и размером.
2. Каталог данных контейнера (`/data` у SeaweedFS).
3. Manifest backup приложения, если backup собирает `packages/database`: он шифруется AES-256-GCM ключом из `BACKUP_ENCRYPTION_KEY_FILE` и включает компонент `object-storage`.

Ключ шифрования и учётные данные в Git не записываются.

## Порядок disposable drill

1. Поднять отдельный контейнер SeaweedFS с новым volume и отдельным bucket. Не монтировать `sgr_registry_minio` и volume RustFS.
2. Загрузить фиксированный набор объектов через S3 API.
3. Сохранить список ключей, размеров, `Content-Type` и SHA-256 вне контейнера.
4. Остановить контейнер.
5. Скопировать `/data` из остановленного контейнера.
6. Удалить только disposable volume.
7. Создать новый volume, вернуть копию `/data`, выставить владельца `10001:10001`.
8. Запустить тот же образ `chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` и тот же S3 identity file. Volume RustFS и legacy MinIO не подключать.
9. Прочитать каждый объект, сравнить размер и SHA-256, убедиться, что лишних объектов нет.

Прогон 2026-09-30 на disposable RustFS: mismatches 0, extra objects 0. Тот же порядок прошёл на reference MinIO и на SeaweedFS 4.48 до выбора провайдера.

## Restore приложения

`packages/database` читает зашифрованный backup и записывает объекты через тот же S3-адаптер. Источник production этим документом не изменяется. Удаление исходного volume после restore этим runbook не разрешено.
