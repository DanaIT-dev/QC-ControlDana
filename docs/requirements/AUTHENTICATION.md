# Аутентификация и доступ

Локальная серверная авторизация внутреннего продукта «Реестр дефектных актов СГР». Внешний identity provider, OAuth, SSO и LDAP не используются.

## Демонстрационные учётные записи

Пять вымышленных пользователей создаются только seed-ом development и test. Production seed не создаёт демо-учётки и не назначает известный пароль.

Единый локальный пароль задаётся в `.env` как `SEED_DEMO_PASSWORD`. Значение из `.env.example` предназначено только для разработки и тестов.

| Email                               | Роль                   | Название                         |
| ----------------------------------- | ---------------------- | -------------------------------- |
| `alexey.viktorov@example.sgr.local` | `ADMIN`                | Администратор                    |
| `marina.sokolova@example.sgr.local` | `SGR_MANAGER`          | Руководитель СГР                 |
| `dmitry.orlov@example.sgr.local`    | `RESPONSIBLE_ENGINEER` | Ответственный инженер            |
| `elena.krylova@example.sgr.local`   | `RESPONSIBLE_ENGINEER` | Ответственный инженер            |
| `igor.panteleev@example.sgr.local`  | `CONTRACTOR_ENGINEER`  | Инженер по работе с подрядчиками |

`SUPER_ADMIN` в seed не создаётся. Синтетическая fixture `super.admin@example.sgr.local` создаётся только в Playwright-базе `sgr_registry_e2e` через `ensureTestSuperAdmin` после `assertE2eDatabaseTarget()`. Development (`sgr_registry`) и integration (`sgr_registry_test`) этим скриптом не трогаются; пароль fixture не записывается в Git.

Повторный seed не создаёт пользователей заново и не меняет `user_credentials.passwordHash`, если текущий хеш по-прежнему соответствует `SEED_DEMO_PASSWORD`.

После входа `SUPER_ADMIN` перенаправляется на `/super-admin`. Остальные роли — на `/registry` (или `/change-password`, если `mustChangePassword`).

## SUPER_ADMIN

Роль изолирована: не wildcard, не иерархия «выше ADMIN». Единственная бизнес-capability — `MANAGE_ADMIN_GRANTS` (назначить или снять обычный `ADMIN`). Создание учётки — только локальная команда `pnpm super-admin:provision` (masked TTY-пароль, 8–128 символов, для non-test цели требуется `SGR_SUPER_ADMIN_PROVISION_CONFIRM=<имя БД>`). `--replace` атомарно архивирует только подтверждённый в TTY email прежнего SUPER_ADMIN; пароль проверяется до первой записи в БД. Наличие активной записи диагностируется через `sgr_active_super_admins()` (SECURITY DEFINER, без `passwordHash`), чтобы RLS migrator/runtime не скрыл строку. Публичный API, панель пользователей и seed production не создают `SUPER_ADMIN`.

## Пароль

- хеш Argon2id;
- исходный пароль не сохраняется;
- `passwordHash` хранится только в `user_credentials` и недоступен `sgr_app` / `sgr_worker` (ни SELECT, ни INSERT/UPDATE). Читает и меняет хеш только auth-компонент (`sgr_auth`);
- при создании и смене пароля: 8–128 символов; заглавная буква, цифра и спецсимвол не обязательны;
- отклоняются слишком короткие и слишком длинные значения, пароль из одних пробелов, пробелы по краям, распространённые пароли, очевидные последовательности, восемь одинаковых символов подряд и совпадение с email/ФИО;
- исходный пароль не обрезается и не приводится к нижнему регистру перед хешированием;
- слишком длинное значение отклоняется до Argon2;
- на входе пароль не нормализуется (нет trim/lowercase/Unicode NFC);
- email нормализуется через trim + lowercase.

## Сессии

Сессии живут только в Redis. Cookie `sgr_session`:

- HttpOnly;
- SameSite=Lax (для переходов из email-уведомлений; CSRF обязателен на мутациях);
- Path=/;
- Max-Age равен абсолютному сроку жизни (по умолчанию 7 дней);
- Secure всегда в production; `Secure=false` только для HTTP localhost в development/test;
- Domain не задаётся;
- значение — непрозрачный случайный идентификатор (≥256 бит), не UUID и не JSON с userId/ролью;
- не сохраняется в `localStorage` / `sessionStorage`.

В Redis хранится SHA-256 идентификатора, не исходное значение cookie.

Ключи (префикс по умолчанию `sgr`, в integration `sgr-test`, в Playwright `sgr-e2e`):

- `sgr:sess:{sha256}` — данные сессии: `userId`, `sessionVersion`, `csrfToken`, `createdAt`, `lastActivityAt`, `absoluteExpiresAt`;
- `sgr:user-sess:{userId}` — индекс сессий пользователя для logout-all и блокировки;
- `sgr:login-fail:{email}:{ip}` — счётчик неуспешных входов.

Срок жизни:

- idle timeout (`SESSION_IDLE_TIMEOUT_SECONDS`, по умолчанию 12 часов) — продлевается активностью;
- absolute lifetime (`SESSION_ABSOLUTE_LIFETIME_SECONDS`, по умолчанию 7 дней) — считается от `createdAt` и не продлевается;
- TTL ключа Redis = минимум оставшегося idle и remaining absolute, поэтому сессия не живёт дольше absolute lifetime.

Если Redis недоступен, авторизация закрывается: защищённый запрос получает 401 без внутренних деталей.

Роль и статус читаются из PostgreSQL на каждый защищённый запрос. Значение роли в Redis не является источником истины. `ARCHIVED` пользователь не входит, получает ту же ошибку, что и при неверном пароле, и теряет активные сессии.

`POST /api/auth/logout` удаляет текущую сессию. `POST /api/auth/logout-all` и смена пароля увеличивают `sessionVersion` и удаляют все сессии пользователя.

## CSRF

Для сессии генерируется `csrfToken`. Изменяющие аутентифицированные запросы требуют заголовок `x-csrf-token`. Login защищается allowlist Origin (`WEB_ORIGIN`) и rate limit, без CSRF-токена. Токен не хранится в `localStorage`.

## Ограничение перебора

Ключ: отдельные счётчики по нормализованному email и по IP (`AUTH_LOGIN_MAX_FAILURES`, `AUTH_LOGIN_IP_MAX_FAILURES`, `AUTH_LOGIN_WINDOW_SECONDS`). Успешный вход сбрасывает счётчик аккаунта. После любого из лимитов — 429 с общим сообщением. Мутации браузера требуют `Origin === WEB_ORIGIN` либо `Referer` с тем же origin. `X-Forwarded-For` учитывается только при `TRUST_PROXY=true` за доверенным прокси, который перезаписывает заголовок.

## Роли и capabilities

Актуальная матрица: [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md). Capabilities считает сервер (`GET /api/auth/capabilities`). Клиент отображает список, но не является источником прав.

`mustChangePassword` блокирует продуктовые API до смены пароля на `/change-password`.

`/registry` доступна активной бизнес-сессии без обязательной смены пароля. `SUPER_ADMIN` туда не попадает: после входа и при прямом переходе на бизнес-маршруты сервер возвращает на `/super-admin`, API бизнес-модулей — `403`. `/system-status` и `/users` — только `ADMIN`. `/acts/new` — ADMIN, SGR_MANAGER и `RESPONSIBLE_ENGINEER` (последнему только на закреплённых объектах). `/reference-data` — ADMIN, SGR_MANAGER и `RESPONSIBLE_ENGINEER` (последнему только просмотр объектов и организаций). `GET /api/health` и `GET /api/ready` остаются машинными.

История изменений: `VIEW_HISTORY` у ADMIN и SGR_MANAGER (полный журнал), `VIEW_ASSIGNED_HISTORY` у RESPONSIBLE_ENGINEER (акты закреплённых объектов). `CONTRACTOR_ENGINEER` не имеет ни одной history-capability: вкладка скрыта, прямые запросы `/history` и `/audit-log` возвращают `403`.

## Аудит

Append-only `AuditLog`: `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `LOGIN_RATE_LIMITED`, `LOGOUT`, `LOGOUT_ALL`, `SESSION_REJECTED_ARCHIVED_USER`, `SESSION_REJECTED_VERSION_MISMATCH`, `ADMIN_GRANTED`, `ADMIN_REVOKED`, `SUPER_ADMIN_PROVISIONED`.

Не записываются пароль, cookie, session id, csrfToken, passwordHash, temporaryPassword. `SUPER_ADMIN` не читает AuditLog.

## Тесты

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
```

Integration-тесты используют `TEST_DATABASE_URL` (имя `*_test`) и раздельные `DATABASE_URL` / `AUTH_DATABASE_URL` / `WORKER_DATABASE_URL` / `MIGRATION_DATABASE_URL`, перенаправленные на test-базу. Playwright использует отдельную базу `sgr_registry_e2e`, Redis DB 14 / `sgr-e2e`, bucket `sgr-attachments-e2e` и не подключается к процессам `pnpm dev`.

API ходит в PostgreSQL как `sgr_app_user`, login/session/password — как `sgr_auth_user`. Секрет RLS (`RLS_CONTEXT_SECRET`) не доступен AUTH и не читается из таблицы runtime-ролями. См. [RLS_OPERATIONS.md](../security/RLS_OPERATIONS.md).

## Production

- не задавать `SEED_DEMO_PASSWORD` как рабочий пароль;
- `NODE_ENV=production` включает Secure cookie, HTTPS `WEB_ORIGIN` / `PUBLIC_APP_URL` и запрещает idle > 12 часов и absolute > 7 дней;
- `TRUST_PROXY` включать только за известным reverse proxy;
- `WEB_ORIGIN` должен быть точным origin веб-приложения;
- Redis обязателен: без него вход и защищённые маршруты недоступны.
