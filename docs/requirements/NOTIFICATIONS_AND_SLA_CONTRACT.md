# Уведомления и контроль сроков

Контракт внутреннего контура уведомлений, email и контроля установленных сроков DefectItem для продукта «Реестр дефектных актов СГР».

Это **не** юридически согласованный SLA подрядчика: в данных нет договора с согласованным SLA. «SLA» в архитектуре означает серверный контроль установленных сроков строки.

## Бизнес-время

- `BUSINESS_TIME_ZONE=Europe/Minsk`
- timestamps хранятся в UTC (`timestamptz`)
- дедлайны сохраняют date-only semantics
- состояние срока считает только сервер
- клиент форматирует время с явным `timeZone: Europe/Minsk`, не браузерной зоной
- повторный расчёт в один бизнес-день не создаёт дубликаты

Реестр по-прежнему считает календарный день срока просроченным (красная строка). Состояние `DUE_TODAY` нужно уведомлениям и экрану «Контроль сроков»; в UI оно может отображаться как «Срок сегодня / Просрочено».

`effectiveDeadline = claimDeadline ?? plannedDeadline`.

## Виды контроля

| Kind        | Источник срока       | Кому предназначен                        |
| ----------- | -------------------- | ---------------------------------------- |
| GENERAL     | `effectiveDeadline`  | ответственные инженеры и руководство СГР |
| THIRD_PARTY | `thirdPartyDeadline` | CONTRACTOR_ENGINEER и руководство СГР    |

THIRD_PARTY не заменяет GENERAL.

## SlaClock и cycle

Таблица `sla_clocks`, уникальность `(defectItemId, kind)`.

Cycle увеличивается, когда:

- изменился авторитетный срок;
- COMPLETED снова стал IN_PROGRESS;
- ранее отсутствовавший срок был установлен.

Изменение `plannedDeadline` при существующем `claimDeadline` **не** поднимает GENERAL cycle.

COMPLETED завершает текущий GENERAL clock: новые WARNING/эскалации не создаются. После reopening создаётся новый cycle; история событий сохраняется.

## Состояния и пороги

`NO_DEADLINE`, `NORMAL`, `WARNING`, `DUE_TODAY`, `OVERDUE`, `COMPLETED`.

По умолчанию в `SystemSettings`:

- `deadlineWarningDays = 3`
- эскалации: 0, 3, 7, 14 дней просрочки
- ежедневная проверка: 08:00 Europe/Minsk (`dailyEvaluationMinuteOfDay = 480`)

Настройки валидируются сервером и не дублируются в Web/worker.

## Получатели

- RESPONSIBLE_ENGINEER: inbox и контроль сроков в object scope (все дефекты закреплённых объектов). События назначения строки (`RESPONSIBLE_ASSIGNED`) по-прежнему адресуются инженерам `DefectItem`. WARNING/DUE/OVERDUE GENERAL, complete/reopen, READY/REJECTED/SCAN_FAILED разрешённых вложений. Никогда B/C.
- CONTRACTOR_ENGINEER: thirdPartyDeadline, THIRD_PARTY WARNING/DUE/OVERDUE, свои вложения, разрешённые Proposal A/B/C. Без суммы Proposal A и без создания актов.
- SGR_MANAGER: GENERAL и THIRD_PARTY warning/due/overdue, эскалации 0/3/7/14, критические ошибки сканирования, изменения статусов и сроков в полном scope.
- ADMIN: весь контур, эскалации и системные ошибки, без повторных писем на одно событие.

Актор не получает уведомление о собственном действии, кроме автоматических deadline alerts. ARCHIVED не получают новые уведомления и email. Снятие назначения отзывает recipient (`revokedAt`); unread/API не раскрывают потерянный Act. Чужой notification id → тот же безопасный 404.

Эскалации:

- GENERAL WARNING и day 0: ответственные + SGR_MANAGER
- GENERAL 3/7/14: + ADMIN
- THIRD_PARTY WARNING и day 0: CONTRACTOR_ENGINEER + SGR_MANAGER
- THIRD_PARTY 3/7/14: + ADMIN

Один пользователь — одно уведомление, даже если подходит по нескольким ролям.

## Transactional outbox

Мутация и `OutboxEvent` пишутся в одной PostgreSQL-транзакции. HTTP mutation не отправляет SMTP. Rollback = нет outbox.

Гарантия: **at-least-once** транспорт + идемпотентная проекция (`occurrenceKey`, unique recipient, unique email delivery). Exactly-once не обещается.

Dispatcher (только worker) берёт событие через `UPDATE ... RETURNING` (claim). BullMQ `jobId` детерминирован и **не содержит `:`** (`outbox-{id}`, `email-{id}`, `sla-{businessDate}`): custom id BullMQ 5 запрещает двоеточие. Retry с exponential backoff, после лимита — `DEAD`. Повторный запуск worker поднимает PENDING/FAILED. HTTP mutation не падает, если постановка в очередь отложена: событие остаётся PENDING и будет подхвачено recover. API не регистрирует processors и не claim outbox.

Stale SLA job (cycle/deadline уже другие или COMPLETED) помечается PROCESSED и не шлёт письмо.

## Email / Mailpit

Development/test: Mailpit (`axllent/mailpit:v1.27.10@sha256:b1f1be18af530d939a11ee8820b379e0c88eeec204d904bfad68862adced3a5a`), порты только localhost. Production SMTP только из env, секреты не в репозитории.

Письма: русский язык, text+HTML, subject без CRLF, HTML escaping, без вложений и без публичных MinIO URL. Ссылка только на защищённую карточку Act (`PUBLIC_APP_URL`, в production HTTPS). Host входящего запроса не используется.

Временная ошибка SMTP → retry. Постоянная → DEAD. `/api/ready` не падает из-за SMTP outage; System Status показывает degraded.

## API

- `GET /api/notifications`, `GET /api/notifications/unread-count`
- `PATCH /api/notifications/:id/read`, `POST /api/notifications/read-all`
- `GET /api/sla/summary`, `GET /api/sla/items`
- `GET/PATCH /api/system/notification-settings` (ADMIN / `MANAGE_NOTIFICATION_SETTINGS`)

Scope в SQL. SMTP password нельзя прочитать даже ADMIN. Stale settings → 409. CSRF + session + mustChangePassword. Unknown fields → 400.

## UI

- колокольчик, badge `99+`, polling 45 с, refetch on focus
- `/notifications` — центр уведомлений
- `/deadlines` — «Контроль сроков», фильтры в URL

## Команды

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:sla:performance
```

Ручной evaluator: при старте worker выполняется catch-up, если за текущий businessDate расчёт не записан. Daily job: `0 8 * * *` Europe/Minsk (или из settings). Параллельные worker не дублируют evaluation: Redis lock на бизнес-дату.

После outage worker: поднять процесс; в логе должно появиться `Notification worker started`; `outbox.recover` и catch-up SLA подхватят PENDING/FAILED. Heartbeat пишется в Redis с TTL (отдельный ключ для test); System Status показывает `up`/`down`. `/api/ready` не зависит от worker.

Обновление Mailpit digest:

```bash
docker pull axllent/mailpit:v1.27.10
docker image inspect axllent/mailpit:v1.27.10 --format '{{index .RepoDigests 0}}'
# подставить image: axllent/mailpit:v1.27.10@sha256:…
docker compose -f infra/docker/compose.yaml --env-file .env up -d --force-recreate mailpit
```
