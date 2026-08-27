# Журнал аудита

`AuditLog` — единственный журнал. Append-only (триггер запрещает UPDATE/DELETE). Пользовательских update/delete endpoints нет.

Поля: action, entityType, entityId, parentEntityType/Id, actorUserId, actorName snapshot, occurredAt UTC, oldValue, newValue, reason, requestId, source `WEB` или `SYSTEM` (сканер).

Не записываются: password, passwordHash, временный пароль, cookie, session id / hash, CSRF, authorization, сырые заголовки, Redis keys, stack traces, MinIO credentials, `objectKey`, `bucket`, raw scanner response.

События вложений: `ATTACHMENT_UPLOADED`, `ATTACHMENT_SCAN_PASSED`, `ATTACHMENT_REJECTED`, `ATTACHMENT_SCAN_FAILED`, `ATTACHMENT_ARCHIVED`. RESPONSIBLE не видит B/C.

Каждая успешная business mutation создаёт запись в той же DB transaction. Stale write и откат не оставляют audit без бизнес-изменения и наоборот.

История newest first, cursor pagination, tie-break по `id`.

RESPONSIBLE_ENGINEER видит только события назначенных DefectItem и безопасный объём шапки Act. События B/C исключаются полностью; totalCount их не считает. Значения не маскируются `null`.
