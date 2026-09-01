# Матрица прав

Источник истины — `packages/domain/src/capabilities.ts`. Роль берётся из сессии, не из тела запроса.

Граница доступа `RESPONSIBLE_ENGINEER` — закреплённые объекты (`PropertyObjectEngineer`, активные строки с `unassignedAt IS NULL`). Назначение инженера на `DefectItem` — операционная принадлежность работы, а не security scope.

| Capability                   | ADMIN | SGR_MANAGER | CONTRACTOR_ENGINEER | RESPONSIBLE_ENGINEER                     |
| ---------------------------- | ----- | ----------- | ------------------- | ---------------------------------------- |
| MANAGE_USERS                 | да    | нет         | нет                 | нет                                      |
| MANAGE_REFERENCE_DATA        | да    | да          | нет                 | нет                                      |
| VIEW_REFERENCE_DATA          | да    | да          | нет                 | да, только объекты и организации         |
| VIEW_SYSTEM_STATUS           | да    | нет         | нет                 | нет                                      |
| VIEW_ALL_ACTS                | да    | да          | да                  | нет                                      |
| VIEW_ASSIGNED_DEFECTS        | —     | —           | —                   | да, все акты закреплённых объектов       |
| CREATE_ACT                   | да    | да          | нет                 | да, только закреплённые активные объекты |
| EDIT_ACT_HEADER              | да    | да          | нет                 | да, закреплённые объекты                 |
| ADD_DEFECT                   | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_ASSIGNMENTS             | да    | да          | нет                 | да, инженеры из состава объекта          |
| EDIT_PLANNED_DEADLINE        | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_CLAIM_DEADLINE          | да    | да          | нет                 | да, закреплённые объекты                 |
| EDIT_THIRD_PARTY_DEADLINE    | да    | да          | да                  | да, закреплённые объекты                 |
| COMPLETE_DEFECT              | да    | да          | нет                 | да, IN_PROGRESS на закреплённом объекте  |
| REOPEN_DEFECT                | да    | да          | нет                 | да, закреплённые объекты                 |
| MANAGE_PROPOSALS             | да    | да          | да                  | нет                                      |
| VIEW_PROPOSAL_A              | да    | да          | да                  | да, только чтение A                      |
| VIEW_HISTORY                 | да    | да          | нет                 | нет                                      |
| VIEW_ASSIGNED_HISTORY        | нет   | нет         | нет                 | да, закреплённые объекты                 |
| VIEW_ACT_CHAT                | да    | да          | нет                 | да, акты закреплённых объектов           |
| CANCEL_ACT                   | да    | да          | нет                 | нет                                      |
| VIEW_ATTACHMENTS             | да    | да          | да                  | да, закреплённые объекты                 |
| UPLOAD_ACT_ATTACHMENT        | да    | да          | нет                 | да, закреплённые объекты                 |
| UPLOAD_DEFECT_ATTACHMENT     | да    | да          | да, THIRD_PARTY     | да, PHOTO/OTHER на объекте               |
| UPLOAD_PROPOSAL_ATTACHMENT   | да    | да          | да, A/B/C           | нет                                      |
| ARCHIVE_ATTACHMENT           | да    | да          | свои                | свои на закреплённых объектах            |
| DOWNLOAD_ATTACHMENT          | да    | да          | READY в scope       | READY в scope                            |
| VIEW_NOTIFICATIONS           | да    | да          | да                  | да, только свой object scope             |
| VIEW_DEADLINE_CONTROL        | да    | да          | THIRD_PARTY         | GENERAL закреплённых объектов            |
| MANAGE_NOTIFICATION_SETTINGS | да    | нет         | нет                 | нет                                      |

Сумма Proposal A видна ADMIN и SGR_MANAGER (`canViewProposalASum`). B/C видны всем, кроме RESPONSIBLE_ENGINEER. Для каждого видимого слота в реестре показываются наименование организации и стоимость. RESPONSIBLE не мутирует A/B/C.

`VIEW_HISTORY` — полный журнал акта. `VIEW_ASSIGNED_HISTORY` — события всех дефектов актов закреплённых объектов (и безопасный объём шапки акта); B/C исключаются. `CONTRACTOR_ENGINEER` не читает историю: вкладка и history API недоступны (`403`), прямой SQL под runtime-ролью тоже пуст. Действия подрядчика по-прежнему пишутся в AuditLog и видны ADMIN и SGR_MANAGER.

`VIEW_ACT_CHAT` — внутреннее обсуждение акта. Подрядчик не имеет capability: вкладка не рендерится, GET/POST чата и кандидаты `@` возвращают `403`. Снятие `PropertyObjectEngineer` сразу закрывает чат ответственному; старые сообщения сохраняются. Упоминание не выдаёт доступ к акту.

Capability без доступа к строке недостаточна: RESPONSIBLE с COMPLETE_DEFECT получает безопасный `404` на акт/дефект чужого объекта. Отсутствие capability → `403`. Завершённый дефект не редактирует RESPONSIBLE; ADMIN и SGR_MANAGER — только с подтверждением и причиной.

PostgreSQL RLS дублирует эту матрицу как второй уровень (объектный scope, слот A vs B/C, запрет истории подрядчику, неизменяемый AuditLog). Подробности: [RLS_POLICY_MATRIX.md](../security/RLS_POLICY_MATRIX.md).
