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

`VIEW_REFERENCE_DATA` даёт `RESPONSIBLE_ENGINEER` read-only доступ к объектам и организациям (`GET /api/reference-data/property-objects`, `GET /api/reference-data/organizations`). Мутации справочников (`POST`/`PATCH`/archive/restore) и прочие виды справочников требуют `MANAGE_REFERENCE_DATA` и для этой роли возвращают `403`. `CONTRACTOR_ENGINEER` справочники не получает.

ADMIN и SGR_MANAGER назначают ответственных инженеров объекта через `responsibleEngineerIds` при создании и правке `PropertyObject` (MultiSelect). Архивный объект не принимает новых инженеров; повторное назначение восстанавливает ту же пару (`unassignedAt = null`). Состав пишется в AuditLog как `OBJECT_ENGINEERS_REPLACED`. Инженеры на DefectItem должны входить в активный состав объекта.

## Создание акта

Атомарная операция: шапка, минимум один DefectItem, назначения, сроки, AuditLog, номер из `allocateActNumber`.

Вручную акты создают роли с `CREATE_ACT`: `ADMIN`, `SGR_MANAGER` и `RESPONSIBLE_ENGINEER`. Инженер создаёт акт только на активном объекте, за которым он закреплён; чужой или архивный `objectId` → тот же безопасный `404`. Автоматическое поступление актов из 1С будет отдельным будущим этапом и дополнит ручной способ, а не заменит его. Поле источника акта и интеграция с 1С в этой версии не реализуются.

Каноническая связь с объектом — только `objectId`. Клиент не передаёт наименование и адрес как доверенные поля: схема `createActRequestSchema` их отклоняет. Сервер проверяет, что объект существует и активен. В форме создания акта наименование и адрес — связанные combobox к одному `objectId`.

Принятое решение: при создании требуется минимум один ответственный инженер с ролью `RESPONSIBLE_ENGINEER`. Снятие последнего инженера допускается только с явным подтверждением, потому что историческая доменная модель допускает пустой список назначений.

Номер и `formCode`/`year`/`sequence` неизменяемы (домен + триггер). Дата акта (`issuedOn`) редактируется в шапке и не меняет уже выданный номер.

`POST /api/acts` требует заголовок `Idempotency-Key`. Повтор с тем же ключом и тем же hash тела возвращает созданный ресурс. Тот же ключ с другим телом → `409 IDEMPOTENCY_KEY_REUSE`. Запись уникальна в БД по `(actorUserId, command, idempotencyKey)`.

## Сроки

Отдельная команда, не generic PATCH.

- ADMIN / SGR_MANAGER: planned, claim, thirdParty.
- CONTRACTOR_ENGINEER: только thirdParty.
- RESPONSIBLE_ENGINEER: planned, claim и thirdParty строк закреплённого объекта.

`effectiveDeadline = claimDeadline ?? plannedDeadline`. `deadlineState` считает сервер. Календарные даты — date-only, `Europe/Minsk`. Первое назначение пустого срока без причины; изменение, очистка и перенос требуют причину. Completed строка не редактируется RESPONSIBLE; ADMIN/SGR_MANAGER — только с подтверждением и причиной.

## Статус DefectItem

`IN_PROGRESS → COMPLETED`: ADMIN, SGR_MANAGER, RESPONSIBLE на дефекте закреплённого объекта. Нужен `readyAt` не в будущем относительно Europe/Minsk.

`COMPLETED → IN_PROGRESS`: ADMIN, SGR_MANAGER и RESPONSIBLE на закреплённом объекте, обязательная причина. `readyAt` очищается; прежние значения остаются в AuditLog.

Неверный переход → `409 INVALID_TRANSITION`. Повтор complete на уже COMPLETED не создаёт новую историю.

## Proposal

Коммерческое предложение, не фактический расход. Сумма — decimal-строка, валюта BYN. Организация выбирается из справочника по `alternativeContractorOrganizationId` (активные `ALTERNATIVE_CONTRACTOR`). Архивная организация не назначается на новое или изменяемое предложение, но её наименование остаётся в истории и read-only представлении уже связанного слота. В реестре организация и стоимость показываются вместе в ячейке слота A/B/C.

Одно активное предложение на `(DefectItem, slot)`. Архив не hard delete. `proposalASum` учитывает только активный слот A.

RESPONSIBLE не мутирует Proposal, получает только A (организация и стоимость); B/C отсутствуют в API, HTML, hydration и истории.

## История

`GET /api/acts/:actId/history` требует `VIEW_HISTORY` или `VIEW_ASSIGNED_HISTORY` до выборки журнала. `CONTRACTOR_ENGINEER` получает `403` на историю акта, дефекта, предложения, пользователей и `/api/audit-log`; тело ошибки не содержит события, авторов и `totalCount`. Действия подрядчика продолжают записываться в AuditLog и доступны ADMIN и SGR_MANAGER. RESPONSIBLE видит историю всех дефектов актов закреплённых объектов; чужой объект → тот же безопасный `404`, B/C в истории нет.

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
