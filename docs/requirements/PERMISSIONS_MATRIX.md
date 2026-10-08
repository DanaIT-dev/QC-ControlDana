# Матрица прав

Источник истины — `packages/domain/src/capabilities.ts`. Роль берётся из сессии, не из тела запроса.

`SUPER_ADMIN` не является расширенной версией `ADMIN` и не наследует его capabilities. Ему выдаются только `VIEW_ALL_BUSINESS_DATA`, `CREATE_UNASSIGNED_USER`, `MANAGE_ADMIN_GRANTS`, `CHANGE_OWN_PASSWORD` и `VIEW_OWN_PROFILE`. Полный просмотр бизнес-данных идёт через `satisfiesCapability` для read-only capabilities, без wildcard и без мутаций процесса. Создание сотрудника без рабочей роли (`PENDING_ROLE`) и grant/revoke `ADMIN` доступны только ему. Назначение рабочих ролей выполняет обычный `ADMIN`.

Граница доступа `RESPONSIBLE_ENGINEER` — закреплённые объекты (`PropertyObjectEngineer`, активные строки с `unassignedAt IS NULL`). Назначение инженера на `DefectItem` — операционная принадлежность работы, а не security scope.

| Capability                        | ADMIN | SGR_MANAGER | CONTRACTOR_ENGINEER | RESPONSIBLE_ENGINEER                     |
| --------------------------------- | ----- | ----------- | ------------------- | ---------------------------------------- |
| MANAGE_ADMIN_GRANTS               | нет   | нет         | нет                 | нет                                      |
| MANAGE_USERS                      | да    | нет         | нет                 | нет                                      |
| MANAGE_REFERENCE_DATA             | да    | да          | нет                 | нет                                      |
| VIEW_REFERENCE_DATA               | да    | да          | нет                 | да, только объекты и организации         |
| VIEW_SYSTEM_STATUS                | да    | нет         | нет                 | нет                                      |
| VIEW_ALL_ACTS                     | да    | да          | нет                 | нет                                      |
| VIEW_ORGANIZATION_ACTS            | нет   | нет         | да                  | нет                                      |
| SUBMIT_DEFECT_FOR_INSPECTION      | нет   | нет         | да                  | нет                                      |
| ACCEPT_DEFECT_REPAIR              | да    | да          | нет                 | да                                       |
| REJECT_DEFECT_REPAIR              | да    | да          | нет                 | да                                       |
| VIEW_ASSIGNED_DEFECTS             | —     | —           | —                   | да, все акты закреплённых объектов       |
| CREATE_ACT                        | да    | да          | нет                 | да, только закреплённые активные объекты |
| START_ACT                         | да    | да          | нет                 | да, только закреплённые активные объекты |
| EDIT_ACT_HEADER                   | да    | да          | нет                 | да, закреплённые объекты                 |
| ADD_DEFECT                        | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_ASSIGNMENTS                  | да    | да          | нет                 | да, инженеры из состава объекта          |
| EDIT_PLANNED_DEADLINE             | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_CLAIM_DEADLINE               | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_THIRD_PARTY_DEADLINE         | да    | да          | да                  | да, закреплённые объекты                 |
| COMPLETE_DEFECT                   | да    | да          | нет                 | да, IN_PROGRESS на закреплённом объекте  |
| REOPEN_DEFECT                     | да    | да          | нет                 | да, закреплённые объекты                 |
| MANAGE_PROPOSALS                  | да    | да          | да                  | нет                                      |
| VIEW_PROPOSAL_A                   | да    | да          | да                  | да, только чтение A                      |
| VIEW_HISTORY                      | да    | да          | нет                 | нет                                      |
| VIEW_ASSIGNED_HISTORY             | нет   | нет         | нет                 | да, закреплённые объекты                 |
| VIEW_ACT_CHAT                     | да    | да          | нет                 | да, акты закреплённых объектов           |
| CANCEL_ACT                        | да    | да          | нет                 | нет                                      |
| VIEW_ATTACHMENTS                  | да    | да          | да                  | да, закреплённые объекты                 |
| UPLOAD_ACT_ATTACHMENT             | да    | да          | нет                 | да, закреплённые объекты                 |
| UPLOAD_DEFECT_ATTACHMENT          | да    | да          | да, THIRD_PARTY     | да, PHOTO/OTHER на объекте               |
| UPLOAD_PROPOSAL_ATTACHMENT        | да    | да          | да, A/B/C           | нет                                      |
| ARCHIVE_ATTACHMENT                | да    | да          | свои                | свои на закреплённых объектах            |
| DOWNLOAD_ATTACHMENT               | да    | да          | READY в scope       | READY в scope                            |
| VIEW_NOTIFICATIONS                | да    | да          | да                  | да, только свой object scope             |
| VIEW_DEADLINE_CONTROL             | да    | да          | THIRD_PARTY         | GENERAL закреплённых объектов            |
| VIEW_QUALITY_ANALYTICS            | да    | да          | нет                 | нет                                      |
| VIEW_FINANCIAL_ANALYTICS          | да    | да          | нет                 | нет                                      |
| VIEW_CROSS_ORGANIZATION_ANALYTICS | да    | да          | нет                 | нет                                      |
| MANAGE_DEFECT_FINANCIALS          | да    | да          | нет                 | нет                                      |
| REVIEW_ANALYTICS_INSIGHTS         | да    | да          | нет                 | нет                                      |
| MANAGE_NOTIFICATION_SETTINGS      | да    | нет         | нет                 | нет                                      |
| CHANGE_OWN_PASSWORD               | да    | да          | да                  | да                                       |
| VIEW_OWN_PROFILE                  | да    | да          | да                  | да                                       |

Обычный `ADMIN` управляет обычными сотрудниками (`SGR_MANAGER`, `RESPONSIBLE_ENGINEER`, `CONTRACTOR_ENGINEER`) и назначает рабочую роль пользователю в `PENDING_ROLE`. Он не назначает и не снимает `ADMIN`, не создаёт `SUPER_ADMIN`, не меняет и не архивирует `ADMIN`/`SUPER_ADMIN` через общий users API.

Сумма Proposal A видна ADMIN, SGR_MANAGER и SUPER_ADMIN (`canViewProposalASum`). B/C видны всем, кроме RESPONSIBLE_ENGINEER. Для каждого видимого слота в реестре показываются наименование организации и стоимость. RESPONSIBLE не мутирует A/B/C.

`VIEW_HISTORY` — полный журнал акта. `VIEW_ASSIGNED_HISTORY` — события всех дефектов актов закреплённых объектов (и безопасный объём шапки акта); B/C исключаются. `CONTRACTOR_ENGINEER` видит только объекты, акты и дефекты, где организация из его активной `UserOrganizationMembership` назначена ответственной (`DefectItemLiableOrganization`). Связь хранится по UUID. Совпадение названия, ФИО, email или строки импорта доступ не даёт. Пользователь без активной membership не видит подрядных актов. Назначать membership может только роль с `MANAGE_USERS`. `SUPER_ADMIN` видит membership только для чтения. Прямой чужой UUID возвращает `404`.

`CONTRACTOR_ENGINEER` не читает историю: вкладка и history API недоступны (`403`), прямой SQL под runtime-ролью тоже пуст. Действия подрядчика по-прежнему пишутся в AuditLog и видны ADMIN и SGR_MANAGER.

`VIEW_ACT_CHAT` — внутреннее обсуждение акта. Подрядчик не имеет capability: вкладка не рендерится, GET/POST чата и кандидаты `@` возвращают `403`. Снятие `PropertyObjectEngineer` сразу закрывает чат ответственному; старые сообщения сохраняются. Упоминание не выдаёт доступ к акту.

`SUPER_ADMIN` не имеет `START_ACT`: кнопка «Взять в работу» скрыта, `POST /api/acts/:actId/start` → `403`. Скрытие кнопки не является единственной защитой: capability, `sgr_start_act` и RLS запрещают мутацию.

Ручное сопоставление импортированного инженера (`POST /api/registry/imported-engineer-references/:id/resolve`) доступно `ADMIN`, `MANAGER` и `SGR_MANAGER`. `SUPER_ADMIN` видит несопоставленные ФИО, но остаётся read-only. Несопоставленная ссылка не выдаёт доступ к акту.

Capability без доступа к строке недостаточна: RESPONSIBLE с COMPLETE_DEFECT получает безопасный `404` на акт/дефект чужого объекта. Отсутствие capability → `403`. Завершённый дефект не редактирует RESPONSIBLE; ADMIN и SGR_MANAGER — только с подтверждением и причиной. Исполнить дефект, пока акт в статусе `NEW`, нельзя (`409`).

PostgreSQL RLS дублирует эту матрицу как второй уровень (объектный scope, слот A vs B/C, запрет истории подрядчику, неизменяемый AuditLog, SELECT-only SUPER_ADMIN). Хеш пароля не входит в user directory и недоступен `ADMIN`/`SUPER_ADMIN`. Подробности: [RLS_POLICY_MATRIX.md](../security/RLS_POLICY_MATRIX.md).

`MANAGER` совпадает с `ADMIN` в аналитических capabilities. Страницу «Аналитика» открывают `ADMIN`, `MANAGER`, `SGR_MANAGER` и `SUPER_ADMIN`. `SUPER_ADMIN` читает аналитику и финансы через oversight и не подтверждает записи и сигналы. `CONTRACTOR_ENGINEER`, `RESPONSIBLE_ENGINEER` и `PENDING_ROLE` не имеют `VIEW_QUALITY_ANALYTICS`: пункт меню скрыт, страница уводит в реестр, API возвращает `403`.
