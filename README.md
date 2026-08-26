# Реестр дефектных актов СГР

Внутренний продукт Dana Holding. Модульный монолит: web, API, worker, PostgreSQL, Redis и S3-совместимое хранилище.

Текущий этап — роль-зависимый реестр дефектов: серверные фильтры, пагинация, сроки и карточка акта. Создание и редактирование актов, CRUD справочников, загрузка документов и интеграция с 1С не входят в эту версию.

## Требования

- Node.js 24 LTS (`24` в `.nvmrc`)
- pnpm 11.24.0 через Corepack
- Docker и Docker Compose для PostgreSQL 18, Redis и MinIO

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

Если команда `pnpm` недоступна в `PATH`, используйте `corepack pnpm` или `~/.local/bin/pnpm`. Не устанавливайте второй экземпляр pnpm и не меняйте глобальные shell-файлы ради этого проекта.

Если Docker недоступен, команды миграции, seed и integration tests завершатся ошибкой подключения. Это ожидаемо: тестовая и development-база не подменяются.

## Корневые команды

| Команда                          | Назначение                                    |
| -------------------------------- | --------------------------------------------- |
| `pnpm dev`                       | Web, API и worker                             |
| `pnpm build`                     | Production-сборка пакетов и приложений        |
| `pnpm lint`                      | ESLint                                        |
| `pnpm typecheck`                 | TypeScript                                    |
| `pnpm test`                      | Unit-тесты                                    |
| `pnpm test:integration`          | Integration-тесты только против `*_test` базы |
| `pnpm test:e2e`                  | Playwright (Chromium): вход и реестр          |
| `pnpm test:registry:performance` | 100k строк только в `*_test` базе             |
| `pnpm format:check`              | Проверка Prettier                             |
| `pnpm db:generate`               | Prisma Client                                 |
| `pnpm db:migrate`                | `prisma migrate deploy`                       |
| `pnpm db:seed`                   | Демонстрационные данные                       |

## Переменные окружения

Скопируйте `.env.example` в `.env`. Приложение проверяет обязательные значения при старте API и worker и сообщает о недостающих ключах, не печатая секреты.

`pnpm test:integration` использует `TEST_DATABASE_URL`. Имя базы должно заканчиваться на `_test`. Development и production URL отвергаются явным сообщением, тесты не пропускаются молча.

## Документация

- [Доменный контракт](docs/requirements/DOMAIN_CONTRACT.md)
- [Аутентификация](docs/requirements/AUTHENTICATION.md)
- [Реестр дефектов](docs/requirements/REGISTRY_CONTRACT.md)
- [Архитектура](docs/architecture/ARCHITECTURE.md)
- [Локальный запуск](docs/runbooks/LOCAL_DEVELOPMENT.md)
