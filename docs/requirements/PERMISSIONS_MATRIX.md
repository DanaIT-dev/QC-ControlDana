# Матрица прав

Источник истины — `packages/domain/src/capabilities.ts`. Роль берётся из сессии, не из тела запроса.

| Capability                | ADMIN | SGR_MANAGER | CONTRACTOR_ENGINEER | RESPONSIBLE_ENGINEER               |
| ------------------------- | ----- | ----------- | ------------------- | ---------------------------------- |
| MANAGE_USERS              | да    | нет         | нет                 | нет                                |
| MANAGE_REFERENCE_DATA     | да    | да          | нет                 | нет                                |
| VIEW_SYSTEM_STATUS        | да    | нет         | нет                 | нет                                |
| VIEW_ALL_ACTS             | да    | да          | да                  | нет                                |
| VIEW_ASSIGNED_DEFECTS     | —     | —           | —                   | да                                 |
| CREATE_ACT                | да    | да          | нет                 | нет                                |
| EDIT_ACT_HEADER           | да    | да          | нет                 | нет                                |
| ADD_DEFECT                | да    | да          | нет                 | нет                                |
| EDIT_ASSIGNMENTS          | да    | да          | нет                 | нет                                |
| EDIT_PLANNED_DEADLINE     | да    | да          | нет                 | да, только назначенные             |
| EDIT_CLAIM_DEADLINE       | да    | да          | нет                 | нет                                |
| EDIT_THIRD_PARTY_DEADLINE | да    | да          | да                  | нет                                |
| COMPLETE_DEFECT           | да    | да          | нет                 | да, только назначенные IN_PROGRESS |
| REOPEN_DEFECT             | да    | да          | нет                 | нет                                |
| MANAGE_PROPOSALS          | да    | да          | да                  | нет                                |
| VIEW_PROPOSAL_A           | да    | да          | да                  | да                                 |
| VIEW_HISTORY              | да    | да          | да                  | да, только свои строки             |
| CANCEL_ACT                | да    | да          | нет                 | нет                                |

Сумма Proposal A видна ADMIN и SGR_MANAGER (`canViewProposalASum`). B/C видны всем, кроме RESPONSIBLE_ENGINEER.

Capability без доступа к строке недостаточна: RESPONSIBLE с COMPLETE_DEFECT получает 404 на чужой DefectItem.
