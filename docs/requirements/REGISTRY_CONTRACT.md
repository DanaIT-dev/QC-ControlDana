# Контракт реестра дефектов

Рабочий экран `/registry` показывает строки дефектов, а не отдельные акты. Операции создания, корректировки, назначений, сроков, статусов и предложений описаны в [OPERATIONS_CONTRACT.md](./OPERATIONS_CONTRACT.md). Registry остаётся server-side: фильтры, пагинация, сортировка и search.

## Гранулярность

- `Act` — официальный документ формы С-1 или С-23.
- `DefectItem` — самостоятельная рабочая строка внутри акта.
- Одна строка таблицы = один `DefectItem`.
- Один акт с тремя дефектами отображается тремя строками с одним номером акта.
- Столбец «Статус» — статус конкретного `DefectItem`.
- Статус всего акта показывается только в карточке акта.
- `rowId` = `DefectItem.id`. Идентификаторы акта и строки передаются отдельно.
- Строку `DefectItem` нельзя называть «отдельным актом».

## Access scope

Доступ к строкам задаётся централизованно (`RegistryAccessScope`) и входит в Prisma `where` для списка, count, summary, filter-options и карточки акта. Клиентские role/capabilities не являются источником прав. Запрещённые строки не отфильтровываются после полной выборки из БД. PostgreSQL RLS (`FORCE`, verified HMAC-контекст) — второй уровень: RESPONSIBLE видит только закреплённые объекты, B/C скрыты от RESPONSIBLE на уровне строк, подрядчик не читает `audit_logs`.

Правила:

- `ADMIN`, `SGR_MANAGER`, `CONTRACTOR_ENGINEER` видят все активные неаннулированные `DefectItem`.
- `RESPONSIBLE_ENGINEER` видит все строки актов, чей объект закреплён за ним через `PropertyObjectEngineer` (`unassignedAt IS NULL`). Назначение на `DefectItem` не ограничивает видимость.
- Несопоставленная ссылка импорта (`ImportedEngineerReference`) не является назначением и не расширяет RLS-scope.
- Summary, `totalCount`, `actCount` и filter-options считаются только в этом scope.
- Фильтр `importedOnly` ограничивает строки актами с `importedAt IS NOT NULL`. Фильтр `unmatchedEngineers` — строками с `ImportedEngineerReference` в статусе `UNMATCHED`.
- Прямой запрос чужого `Act`/`DefectItem` даёт такой же безопасный 404, как отсутствие записи.
- Назначение объекта проверяется только по `User.id`, не по ФИО и не по email.

Аннулированные акты не входят в обычный реестр.

## Коммерческие поля

`Proposal` — коммерческое предложение слотов A/B/C, не фактические затраты и не оплаченные расходы. Каноническая связь с организацией — `alternativeContractorOrganizationId`; название не дублируется текстовым полем. Клиенту для видимого слота отдаются `slot`, `contractorName`, `amount` и `currency`. Организация подгружается в основном запросе реестра (`include/select` по `officialName`), без N+1.

В таблице и мобильных карточках реестра организация и стоимость отображаются вместе в одной ячейке слота (две строки), без отдельных столбцов. Организация выбирается из справочника активных альтернативных подрядчиков в диалоге предложения.

- `ADMIN`, `SGR_MANAGER`, `CONTRACTOR_ENGINEER` видят A, B и C. Мутации A/B/C — у ролей с `MANAGE_PROPOSALS`.
- В `proposalASum` и карточках реестра учитываются только активные предложения.
- `RESPONSIBLE_ENGINEER` видит только A, включая организацию и стоимость A. Поля B/C отсутствуют в JSON, DTO, HTML, hydration и filter metadata — не `null` и не маски.
- `proposalASum` доступна только `ADMIN` и `SGR_MANAGER`, называется «Сумма предложений А», сериализуется строковым decimal и валютой `BYN`.
- `CONTRACTOR_ENGINEER` не получает `proposalASum`.

Сериализация выполняется на сервере. Клиент не вырезает запрещённые поля.

## Пагинация, поиск, фильтры, сортировка

Endpoints (нужна сессия):

- `GET /api/registry/defects`
- `GET /api/registry/filter-options`
- `GET /api/registry/summary`
- `GET /api/acts/:actId`

Пагинация: `page` с 1, `pageSize` только 25/50/100/200, по умолчанию 50. Неверное значение → 400. Выборка через `skip`/`take`.

Поиск (trim, без учёта регистра, после 2 символов): номер акта, помещение, объект, адрес, заказчик, виновная организация. Пустой search не добавляет условие. Запрос параметризован.

Независимые фильтры комбинируются через AND, мультивыбор внутри одного фильтра — через OR. Filter-options содержат только значения из доступного scope и сортируются по русскому названию.

Сортировка только по whitelist: `actNumber`, `status`, `objectName`, `defectTypeName`, `plannedDeadline`, `claimDeadline`, `effectiveDeadline`, `readyAt`, `createdAt`. По умолчанию `effectiveDeadline` по возрастанию, строки без срока после строк со сроком, затем номер акта и `DefectItem.id`.

## Сроки

Бизнес-часовой пояс: `BUSINESS_TIME_ZONE=Europe/Minsk`.

- timestamps хранятся в UTC;
- календарные дедлайны имеют date-only семантику и не сдвигаются браузерной зоной;
- `effectiveDeadline = claimDeadline ?? plannedDeadline`;
- срок официальной претензии заменяет плановый срок для контроля просрочки;
- `thirdPartyDeadline` не влияет на цвет строки на этом этапе;
- `deadlineWarningDays` берётся из `SystemSettings` (по умолчанию 3).

Для `IN_PROGRESS`:

- `NO_DEADLINE` — срока нет;
- `NORMAL` — до срока больше `deadlineWarningDays`;
- `WARNING` — осталось от 1 до `deadlineWarningDays` календарных дней;
- `OVERDUE` — календарный день срока уже наступил (`businessToday >= effectiveDeadline`).

Для `COMPLETED` состояние всегда `COMPLETED`, историческая просрочка не рассчитывается.

Клиент получает готовые `deadlineState` и `effectiveDeadline`.

## Карточка акта

`GET /api/acts/:actId` — полностью read-only. `RESPONSIBLE_ENGINEER` открывает акт закреплённого объекта и получает все его `DefectItem` без Proposal B/C.

Вкладка «Обсуждение» доступна ролям с `VIEW_ACT_CHAT`. Подрядчик вкладку не видит; DTO карточки не содержит счётчик сообщений. `@` упоминание ведёт во внутреннее уведомление и открывает `?tab=discussion`. Сообщения — plain text (HTML не исполняется), Enter отправляет, Shift+Enter — новая строка. Обновление новых сообщений — polling только при открытой вкладке.

## Команды проверки

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:registry:performance
```

Performance-набор ≥ 100 000 `DefectItem` создаётся только в `*_test` базе, проверяет серверную пагинацию и удаляется после прогона. Development-данные не затрагиваются.
