# Playwright / E2E

Playwright-сюиты лежат в `apps/web/e2e`. Они не используют development-базу.

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm test:e2e` — обёртка `packages/database/scripts/run-e2e.ts`. Она:

1. Снимает checksum development (`sgr_registry`, Redis prefix `sgr` / DB 0, MinIO `sgr-attachments`).
2. Fail-closed проверяет цель (`assertE2eDatabaseTarget`): только `sgr_registry_e2e`, Redis DB 14 / `sgr-e2e`, bucket `sgr-attachments-e2e`, loopback, runtime-роли не migrator/owner.
3. Пересоздаёт только `sgr_registry_e2e`, мигрирует, seed, создаёт fixture SUPER_ADMIN.
4. Поднимает web/api/worker на портах 3200/3201/3202 (`reuseExistingServer: false`, не `pnpm dev`). Next.js пишет в `.next-e2e`, чтобы не конфликтовать с development `.next`.
5. После прогона сравнивает checksum development и удаляет только E2E DB / ключи `sgr-e2e:*` / объекты E2E-bucket.

Не запускайте `playwright test` напрямую: конфигурация откажется стартовать без `SGR_E2E_TARGET_CONFIRM=sgr_registry_e2e`.

Mailpit (SMTP 1025) — локальная заглушка, общая с development UI; письма E2E не пишутся в `sgr_registry`.

Очистка test-данных: только E2E-среда. `sgr_registry` и `sgr_registry_test` скрипт не truncate и не drop.
