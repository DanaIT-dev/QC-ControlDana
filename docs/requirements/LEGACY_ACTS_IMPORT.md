# Импорт исторического реестра дефектных актов

Источник — лист «Реестр актов» локального Excel. Файл не хранится в Git. Формулы не исполняются. Вложения и Bitrix-документы не скачиваются.

Development-цель — `sgr_registry`. Production-импорт запрещён. Playwright использует только `sgr_registry_e2e`.

## Онтологические инварианты

```text
source record is immutable
source provenance is required
sourceImportKey is deterministic
repeated import is idempotent
unmatched engineer is not a user
unresolved reference grants no access
ambiguous match requires human decision
fuzzy match cannot create assignment
missing value is not zero
missing status is not completed
import rollback is batch-scoped
audit history is not physically deleted
```

| Инвариант                                  | Как соблюдается                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Исходная запись неизменна                  | Повторный импорт не переписывает пользовательские правки; конфликт payload блокирует apply    |
| Provenance обязателен                      | `ImportBatch`, `sourceImportKey`, SHA-256 файла, исходные строки и Bitrix URL                 |
| `sourceImportKey` детерминирован           | Стабильный ключ из нормализованных полей источника                                            |
| Повтор идемпотентен                        | Совпадающий ключ → unchanged, без новых актов/дефектов/назначений                             |
| Несопоставленный инженер — не пользователь | Пользователи и credentials не создаются из ФИО Excel                                          |
| Unresolved не даёт доступ                  | RLS смотрит только `PropertyObjectEngineer`; ссылка импорта не входит в `sgr_object_assigned` |
| Ambiguous требует человека                 | `AMBIGUOUS` блокирует apply                                                                   |
| Fuzzy запрещён                             | Только точное сравнение ключа/инициалов                                                       |
| Пустое ≠ ноль                              | Пустые цены и предложения не создают `0.00`                                                   |
| Нет статуса ≠ исполнен                     | `IMPORTED_UNSPECIFIED`, ярлык «Статус не указан»                                              |
| Rollback только batch                      | `--rollback-batch` удаляет акты/дефекты/ссылки пакета; справочники и пользователи сохраняются |
| Audit не удаляется                         | Rollback не делает DELETE из `audit_logs`                                                     |

## Сопоставление инженеров

```text
MATCHED    → реальное DefectItemEngineer
UNMATCHED  → исходное ФИО сохраняется, импорт не блокируется
AMBIGUOUS  → apply запрещён
RESOLVED   → последующее точное сопоставление
```

Автоматическое reconciliation после создания ответственного инженера, смены ФИО, назначения роли `RESPONSIBLE_ENGINEER` и восстановления из архива — только если ровно один точный кандидат. Ручное сопоставление: `ADMIN`, `MANAGER`, `SGR_MANAGER`. `SUPER_ADMIN` видит данные, но не сопоставляет.

## Отображение ФИО

Краткий формат (`formatPersonShort`) — реестр, карточки, таблицы, объекты, контроль сроков, уведомления, AuditLog, dropdown, chips, мобильные карточки, dry-run, сопоставление.

Полный формат (`formatPersonFull`) — карточка пользователя, формы создания/редактирования, `title` / accessible name у краткого отображения.

Повторный импорт сравнивает только source-owned поля. Рабочий статус акта, `startedAt`, назначения, сроки, предложения, комментарии и вложения принадлежат системе после первого импорта и не считаются payload conflict.

`sourceStatusRaw` остаётся доказательством Excel. `Act.status` может стать `IN_PROGRESS` независимо.

## Команды

```bash
pnpm acts:import -- --file="/absolute/path.xlsx" --dry-run --expect-sha256=<sha256>
SGR_ACTS_IMPORT_CONFIRM=sgr_registry pnpm acts:import -- --file="..." --apply --confirm-database=sgr_registry --expect-sha256=<sha256>
pnpm acts:import -- --rollback-batch=<importBatchId> --confirm-database=sgr_registry_e2e
```
