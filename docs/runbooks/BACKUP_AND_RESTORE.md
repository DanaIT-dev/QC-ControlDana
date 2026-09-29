# Backup и восстановление

Backup не хранится на runtime-томе PostgreSQL или MinIO. Ключ шифрования не лежит в каталоге backup и не коммитится.

## Что сохраняется

- PostgreSQL: custom-format `pg_dump` выбранной базы.
- MinIO: объекты выбранного bucket и их SHA-256.
- Метаданные без секретов: назначение копии и имя базы/bucket.
- Manifest: класс хранения, SHA-256 открытого bundle и SHA-256 шифротекста.

Шифрование: AES-256-GCM из Node.js `crypto`, ключ выводится через scrypt из файла ключа. Это authenticated encryption. LibreSSL `openssl enc` на macOS не используется: в нём нет рабочего AES-GCM. Пароли пользователей остаются Argon2id и не шифруются обратимо.

Политика хранения по умолчанию: 7 daily, 4 weekly, 3 monthly. Копия первого числа месяца считается monthly, воскресная — weekly.

Коды выхода drill: `0` успех, `2` конфигурация, `3` сбой backup, `4` checksum, `5` расхождение восстановления, `6` затронута development-база.

## Проверка восстановления

Drill создаёт только `sgr_restore_drill_src`, `sgr_restore_drill_dst`, `sgr-restore-drill-src-test` и `sgr-restore-drill-dst-test`. Восстановление в `sgr_registry`, `sgr_registry_test` и `sgr_registry_e2e` запрещено кодом.

```bash
pnpm ops:restore:drill
```

Команда сравнивает количество записей development-базы и число объектов development-bucket до и после, затем удаляет только drill-ресурсы.

## Production

Каталог `BACKUP_ROOT` и файл `BACKUP_ENCRYPTION_KEY_FILE` задаются на хосте оператора. API-контейнер не получает ключ backup. Потеря ключа делает существующие копии нечитаемыми; новый ключ применяется только к следующим копиям. Старые копии хранят до истечения retention и восстановления из ещё доступного ключа.

Восстановление production — отдельное решение: поднять пустой инстанс, расшифровать копию, выполнить `pg_restore` и загрузить объекты MinIO, затем сверить manifest. Автоматический rollback миграции поверх уже изменённых production-данных не выполняется.
