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

Повторный seed не создаёт пользователей заново и не меняет `passwordHash`, если текущий хеш по-прежнему соответствует `SEED_DEMO_PASSWORD`.

## Пароль

- хеш Argon2id;
- исходный пароль не сохраняется;
- `passwordHash` не возвращается API;
- при создании пароля: 12–128 символов, заглавная, строчная, цифра и специальный символ;
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

Ключи (префикс по умолчанию `sgr`, в тестах `sgr-test`):

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

Ключ: нормализованный email + IP. Не более 5 неуспешных попыток за 15 минут (`AUTH_LOGIN_MAX_FAILURES`, `AUTH_LOGIN_WINDOW_SECONDS`). Успешный вход сбрасывает счётчик. После лимита — 429 с общим сообщением. `X-Forwarded-For` учитывается только при `TRUST_PROXY=true`.

## Роли и capabilities

Актуальная матрица: [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md). Capabilities считает сервер (`GET /api/auth/capabilities`). Клиент отображает список, но не является источником прав.

`mustChangePassword` блокирует продуктовые API до смены пароля на `/change-password`.

`/registry` доступна активной сессии без обязательной смены пароля. `/system-status` и `/users` — только `ADMIN`. `/reference-data` и `/acts/new` — ADMIN и SGR_MANAGER. `GET /api/health` и `GET /api/ready` остаются машинными.

## Аудит

Append-only `AuditLog`: `LOGIN_SUCCEEDED`, `LOGIN_FAILED`, `LOGIN_RATE_LIMITED`, `LOGOUT`, `LOGOUT_ALL`, `SESSION_REJECTED_ARCHIVED_USER`, `SESSION_REJECTED_VERSION_MISMATCH`.

Не записываются пароль, cookie, session id, csrfToken, passwordHash, temporaryPassword.

## Тесты

```bash
pnpm test
pnpm test:integration
pnpm test:e2e
```

Integration-тесты используют только `TEST_DATABASE_URL` с именем базы `*_test`. Playwright поднимает Chromium и проверяет вход, роли, logout и вёрстку 390 px.

## Production

- не задавать `SEED_DEMO_PASSWORD` как рабочий пароль;
- `NODE_ENV=production` включает Secure cookie, HTTPS `WEB_ORIGIN` / `PUBLIC_APP_URL` и запрещает idle > 12 часов и absolute > 7 дней;
- `TRUST_PROXY` включать только за известным reverse proxy;
- `WEB_ORIGIN` должен быть точным origin веб-приложения;
- Redis обязателен: без него вход и защищённые маршруты недоступны.
