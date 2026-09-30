# Миграция объектного хранилища

Проверка перед заменой, 2026-09-30:

```text
bucket sgr-attachments:        0 objects, 0 bytes
bucket sgr-attachments-test:   0 objects
bucket sgr-attachments-e2e:    0 objects
attachment rows:               0
attachment rows with objectKey: 0
orphan objects:                0
missing objects:               0
```

Копирование данных не требуется: в development нет ни одного объекта и ни одной ссылки из PostgreSQL.

Старые volume не удаляются:

```text
sgr_registry_minio
sgr_minio
sgr_staging_minio
```

Они остаются в compose как legacy и не монтируются в `object-storage`. Контейнер `sgr-registry-minio` останавливается без `docker rm` и без `docker volume rm`.

Если инвентарь позже покажет объекты, замена останавливается. Допустимый путь: source только на чтение, копирование, сверка размера и SHA-256, повторный запуск без перезаписи совпавшего ключа, удаление source запрещено, переключение только после сверки каждого объекта. Production этим документом не мигрируется.

Активный сервис после замены — `object-storage` на RustFS 1.0.0. SeaweedFS 4.48 прошёл тот же контракт и оставлен запасным вариантом, потому что его `mini` topology запускает дополнительные службы и процесс идёт от root.
