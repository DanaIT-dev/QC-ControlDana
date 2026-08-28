# Реестр дефектных актов СГР

Внутренний продукт Dana Holding. Модульный монолит: web, API, worker, PostgreSQL, Redis и S3-совместимое хранилище.

Текущий этап — уведомления, контроль сроков, Mailpit/SMTP и transactional outbox. 1С, SMS, Telegram, WebSocket, PostgreSQL RLS не входят в эту версию.

## UI

Клиент `apps/web` использует Next.js App Router, Tailwind CSS v4, shadcn/ui (Radix, исходники в `apps/web/components/ui`), Lucide, TanStack Query и TanStack Table. Дизайн-токены и правила описаны в [UI design system](docs/design/UI_DESIGN_SYSTEM.md).

## Требования

- Node.js 24 LTS (`24` в `.nvmrc`)
- pnpm 11.24.0 через Corepack
- Docker и Docker Compose для PostgreSQL 18, Redis, MinIO, ClamAV и Mailpit

## Первый запуск

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
cp .env.example .env
pnpm install
pnpm db:generate
docker compose -f infra/docker/compose.yaml --env-file .env up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web: http://localhost:3000
- Вход: http://localhost:3000/login
- API health: http://localhost:3001/api/health
- API ready: http://localhost:3001/api/ready
- Worker liveness: http://127.0.0.1:3002/health

Если команда `pnpm` недоступна в `PATH`, используйте `corepack pnpm` или `~/.local/bin/pnpm`. Не устанавливайте второй экземпляр pnpm и не меняйте глобальные shell-файлы ради этого проекта.

Если Docker недоступен, команды миграции, seed и integration tests завершатся ошибкой подключения. Это ожидаемо: тестовая и development-база не подменяются.

## Корневые команды

| Команда                        | Назначение                                                             |
| ------------------------------ | ---------------------------------------------------------------------- |
| `pnpm dev`                     | Web, API и worker                                                      |
| `pnpm build`                   | Production-сборка пакетов и приложений                                 |
| `pnpm lint`                    | ESLint                                                                 |
| `pnpm typecheck`               | TypeScript                                                             |
| `pnpm test`                    | Unit-тесты                                                             |
| `pnpm test:integration`        | Integration-тесты только против `*_test` базы                          |
| `pnpm test:e2e`                | Playwright (Chromium): вход, реестр, операции, вложения, визуальный QA |
| `pnpm test:attachments:stream` | Streaming/RSS против test bucket MinIO                                 |
| `pnpm test:sla:performance`    | 100k DefectItem, cursor evaluator, без массовой email-отправки         |
| `pnpm format:check`            | Проверка Prettier                                                      |
| `pnpm db:generate`             | Prisma Client                                                          |
| `pnpm db:migrate`              | `prisma migrate deploy`                                                |
| `pnpm db:seed`                 | Демонстрационные данные                                                |

## Переменные окружения

Скопируйте `.env.example` в `.env`. Приложение проверяет обязательные значения при старте API и worker и сообщает о недостающих ключах, не печатая секреты.

`pnpm test:integration` использует `TEST_DATABASE_URL`. Имя базы должно заканчиваться на `_test`. Development и production URL отвергаются явным сообщением, тесты не пропускаются молча.

## Документация

- [Уведомления и контроль сроков](docs/requirements/NOTIFICATIONS_AND_SLA_CONTRACT.md)
- [Безопасность](docs/requirements/SECURITY.md)
- [Аудит SAST/DAST 2026-08-28](docs/security/SECURITY_AUDIT_2026-08-28.md)
- [UI-система](docs/design/UI_DESIGN_SYSTEM.md)
- [Операционный контур](docs/requirements/OPERATIONS_CONTRACT.md)
- [Матрица прав](docs/requirements/PERMISSIONS_MATRIX.md)
- [Журнал аудита](docs/requirements/AUDIT_CONTRACT.md)
- [Доменный контракт](docs/requirements/DOMAIN_CONTRACT.md)
- [Аутентификация](docs/requirements/AUTHENTICATION.md)
- [Реестр дефектов](docs/requirements/REGISTRY_CONTRACT.md)
- [Архитектура](docs/architecture/ARCHITECTURE.md)
- [Локальный запуск](docs/runbooks/LOCAL_DEVELOPMENT.md)
