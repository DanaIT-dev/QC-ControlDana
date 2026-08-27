# Операционный контракт

Этап 4 превращает read-only реестр в рабочий контур: справочники, пользователи, создание и корректировка актов, назначения, сроки, статусы, предложения и история.

## Capability и доступ к строке

Это две обязательные и разные проверки.

1. Capability определяется сервером по `User.role` из сессии. Клиент не является источником авторизации.
2. `RegistryAccessScope` ограничивает видимые Act/DefectItem. Недоступная сущность → безопасный `404`.

Отсутствие capability на существующий раздел → `403`.

## Пользователи

- Публичной регистрации нет. Создаёт только ADMIN.
- Email нормализуется и уникален без учёта регистра.
- Пароль хранится только как Argon2 hash.
- Временный пароль генерируется на сервере, показывается ADMIN один раз, в AuditLog не попадает.
- `mustChangePassword = true` после создания и сброса. До смены пароля доступны только смена пароля, logout и необходимые auth endpoints.
- Архивный пользователь не входит и не предлагается в новых назначениях. Физического удаления нет.
- Нельзя архивировать себя. Нельзя архивировать или понизить последнего активного ADMIN.
- Смена роли, статуса или пароля увеличивает `sessionVersion` и завершает сессии. Смена собственного пароля перевыпускает текущую сессию.

## Справочники

`PropertyObject`, `Organization`, `WorkType`, `DefectType`. Формы актов и системные enum не редактируются как справочники.

Архивное значение не предлагается для новых данных, остаётся в старых связях, восстанавливается ADMIN/SGR_MANAGER. Hard delete запрещён.

`DefectType` не связан с `WorkType` в текущей schema — связь не добавлялась.

## Создание акта

Атомарная операция: шапка, минимум один DefectItem, назначения, сроки, AuditLog, номер из `allocateActNumber`.

Принятое решение: при создании требуется минимум один ответственный инженер с ролью `RESPONSIBLE_ENGINEER`. Снятие последнего инженера допускается только с явным подтверждением, потому что историческая доменная модель допускает пустой список назначений.

Номер и `formCode`/`year`/`sequence` неизменяемы (домен + триггер). Дата акта (`issuedOn`) редактируется в шапке и не меняет уже выданный номер.

`POST /api/acts` требует заголовок `Idempotency-Key`. Повтор с тем же ключом и тем же hash тела возвращает созданный ресурс. Тот же ключ с другим телом → `409 IDEMPOTENCY_KEY_REUSE`. Запись уникальна в БД по `(actorUserId, command, idempotencyKey)`.

## Сроки

Отдельная команда, не generic PATCH.

- ADMIN / SGR_MANAGER: planned, claim, thirdParty.
- CONTRACTOR_ENGINEER: только thirdParty.
- RESPONSIBLE_ENGINEER: только planned назначенной строки.

`effectiveDeadline = claimDeadline ?? plannedDeadline`. `deadlineState` считает сервер. Календарные даты — date-only, `Europe/Minsk`. Первое назначение пустого срока без причины; изменение, очистка и перенос требуют причину. Completed строка не редактируется RESPONSIBLE; ADMIN/SGR_MANAGER — только с подтверждением и причиной.

## Статус DefectItem

`IN_PROGRESS → COMPLETED`: ADMIN, SGR_MANAGER, назначенный RESPONSIBLE. Нужен `readyAt` не в будущем относительно Europe/Minsk.

`COMPLETED → IN_PROGRESS`: только ADMIN и SGR_MANAGER, обязательная причина. `readyAt` очищается; прежние значения остаются в AuditLog.

Неверный переход → `409 INVALID_TRANSITION`. Повтор complete на уже COMPLETED не создаёт новую историю.

## Proposal

Коммерческое предложение, не фактический расход. Сумма — decimal-строка, валюта BYN. Одно активное предложение на `(DefectItem, slot)`. Архив не hard delete. `proposalASum` учитывает только активный слот A.

RESPONSIBLE не мутирует Proposal, получает только A; B/C отсутствуют в API, HTML, hydration и истории.

## Optimistic concurrency

Изменяемые сущности имеют `version`. Команда передаёт `expectedVersion`. Конфликт → `409 STALE_WRITE`, AuditLog не пишется.

## Ошибки API

- 400 валидация / неизвестные поля
- 401 нет сессии
- 403 CSRF, нет capability, mustChangePassword
- 404 нет сущности или нет row access
- 409 stale, duplicate, invalid transition, idempotency reuse, last admin, self-archive
- 413 файл больше лимита
- внутренние ошибки без Prisma details

Вложения: XOR-владелец, stream upload, ClamAV до READY, архив без физического DELETE. См. [ATTACHMENTS_CONTRACT.md](./ATTACHMENTS_CONTRACT.md).

PostgreSQL RLS по-прежнему не используется: действует прикладной `RegistryAccessScope`.
