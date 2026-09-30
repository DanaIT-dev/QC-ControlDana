# AMD64 release candidate

Этот runbook выпускает только staging candidate для `linux/amd64`. Он не переключает DNS, не выпускает production-сертификат и не загружает данные заказчика.

## Порядок, который не зацикливает Git SHA

1. Изменить workflow, validators и документацию.
2. Прогнать локальные проверки.
3. Создать один commit `ci: publish signed amd64 release candidates` и обычный push в `origin/main`.
4. Зафиксировать полученный SHA. Это source commit релиза.
5. Запустить `.github/workflows/release-candidate.yml` через `workflow_dispatch` с этим SHA, `environment=staging`, и нужными `publish` / `deploy`.
6. Workflow передаёт этот SHA в `org.opencontainers.image.revision`.
7. Digest, SBOM, provenance, подпись и release-bound OpenVEX прикрепляются к опубликованному digest и к GitHub Actions artifact. Новый commit ради digest не создаётся.

Идентификатор релиза: `rc-YYYYMMDD-<12-символьный sha>`. Git tag не создаётся: workflow имеет `contents: read`. Неизменяемая ссылка — `repository@sha256:<digest>`, а не плавающий tag. Tag `latest` запрещён.

## Что публикуется

Собственные образы, одним filesystem image для API и worker:

| Роль        | Репозиторий                                  | Команда                         |
| ----------- | -------------------------------------------- | ------------------------------- |
| qc-api      | `ghcr.io/<owner>/qc-controldana/qc-api`      | `node apps/api/dist/main.js`    |
| qc-worker   | `ghcr.io/<owner>/qc-controldana/qc-worker`   | `node apps/worker/dist/main.js` |
| qc-web      | `ghcr.io/<owner>/qc-controldana/qc-web`      | `node apps/web/server.js`       |
| qc-migrator | `ghcr.io/<owner>/qc-controldana/qc-migrator` | `prisma migrate deploy`         |

API и worker — один digest. В manifest это две строки с общим `sharedRuntimeDigest` и разными командами. Vendor-образы Caddy, PostgreSQL, Redis, MinIO и ClamAV не перепубликовываются. В staging compose у каждого сервиса `platform: linux/amd64`.

## MinIO

Официальный образ: `minio/minio:RELEASE.2025-04-22T22-12-26Z`. Upstream release: `https://github.com/minio/minio/releases/tag/RELEASE.2025-04-22T22-12-26Z`.

Пока Docker Hub отвечает `insufficient_scope`, amd64 digest не записывается. Локальный arm64 image id не используется. Случайный fork не используется. `scripts/release/resolve-official-manifest.mjs` пишет `artifacts/release/minio-probe.json` и не подставляет digest. Без подтверждённого digest deployable manifest не создаётся, staging deploy в workflow выключен.

Нужное действие: войти в Docker Hub с правом `repository:minio/minio:pull`, повторить probe и записать отдельно manifest-list digest и `linux/amd64` platform digest.

## Подпись

Keyless Cosign через OIDC GitHub Actions. Ожидаемая identity записана в `docs/security/cosign-identity-policy.json`. Локальный ключ не генерируется. Проверка — отдельный `cosign verify` с тем же issuer и workflow identity.

## OpenVEX и CVE-2026-6653

`docs/security/openvex.json` остаётся policy assessment. Release-bound документ строится `scripts/release/render-release-vex.mjs` только после публикации и только на финальный digest.

CVE-2026-6653 — use-after-free в libxml2. ClamAV передаёт загруженный документ в этот parser, поэтому путь достижим из пользовательского вложения и не классифицируется как `NOT_AFFECTED`. Сценарий — отказ в обслуживании, не выполнение кода. Контейнер не публикует порт, сидит во внутренней сети, ограничен 1 CPU и 2 ГБ, restart policy `unless-stopped`, тело запроса режется 22 МБ и 60 с. Исправленный официальный digest не подтверждён. Временное исключение до `2026-10-30` не подписано risk owner. Staging в изолированной среде может быть описан как PARTIAL. Production gate закрыт.

## Staging

Хост должен заранее содержать маркер `/etc/sgr-staging-marker` со значением `staging`, архитектуру `x86_64` и отдельные volume, secret store, PostgreSQL, Redis и MinIO. Workflow сравнивает `uname -m` и маркер до подключения и не печатает секреты. Production environment в workflow отсутствует.

До миграции непустая staging БД копируется off-host, checksum записывается, содержимое credential tables не печатается. Миграция — только `prisma migrate deploy` из migrator image. Повторный запуск должен показать отсутствие pending migrations. Seed и reset запрещены.

Rollback application images — смена digest на предыдущий immutable reference. Если старый образ не читает новую схему, database rollback не делается: фиксируется ограничение и используется roll-forward либо restore backup на чистые staging-тома. Development и production не затрагиваются.

## Наблюдаемость

Health и readiness API, health контейнеров, restart count, логи json-file и проверки PostgreSQL, Redis, MinIO, ClamAV входят в compose. Отдельный monitoring stack для production ещё не развёрнут и остаётся блокером production, не технического описания staging.

## Локальная проверка без registry

```bash
pnpm ops:release-candidate
node scripts/release/resolve-official-manifest.mjs
node scripts/release/write-gate-artifact.mjs
```

Ожидаемый итог без registry, Docker Hub auth и реального `x86_64` staging — `PARTIAL`. `PASS` допустим только при опубликованных digest, подтверждённом MinIO amd64, проверенной подписи, release-bound VEX, утверждённом critical waiver и staging acceptance на `x86_64`.
