# Цепочка поставки production-образов

Целевая архитектура production — `linux/amd64`. `linux/arm64` — второй поддерживаемый вариант, а не замена серверной сборки. Локальная проверка на arm64 не подтверждает amd64 production.

Каталог digest: `infra/docker/image-pins.json`. Дата проверки manifest list — `2026-09-30`. Источник — `docker buildx imagetools inspect`.

Manifest digest не равен platform digest. Git SHA не равен Docker digest. Локальный image id не равен digest, опубликованному в registry. Отсутствие `FixedVersion` не означает отсутствие риска. Закрытый порт не устраняет уязвимость package. VEX требует доказательства runtime applicability.

## Четыре разные операции

- local single-platform validation: сборка и smoke на машине разработчика, в том числе amd64 через buildx/QEMU.
- multi-platform build: `docker buildx build --platform linux/amd64,linux/arm64` без `docker load` как доказательства manifest.
- registry manifest publication: не выполнен. `multi-arch registry manifest: NOT PUBLISHED`.
- production deployment: не начат. Smoke на настоящем amd64-хосте обязателен отдельно.

`docker load` не доказывает multi-arch manifest: локальный image store хранит одну платформу на tag.

## Digest

Предпочтительная ссылка для образа с подтверждённым manifest list:

```text
repository:version@sha256:<multi-arch-manifest-digest>
platform: ${SGR_PLATFORM:-linux/amd64}
```

MinIO не имеет подтверждённого amd64 digest. Compose требует `SGR_MINIO_IMAGE_DIGEST` и не подставляет локальный arm64 id `sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e`. Пока digest не подтверждён для `linux/amd64`, MinIO не готов к production.

Собственные образы не публикуются этим репозиторием. Их digest — локальный image id после `docker buildx build --platform linux/amd64 --load`. Readiness не требует выдуманный registry digest.

## SBOM

CycloneDX создаётся Trivy и остаётся артефактом `artifacts/supply-chain/sbom/`. В Git хранится этот runbook и checksum в `docs/security/sbom-index.json`, без scanner cache и без секретов.

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.66.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e \
  image --format cyclonedx --platform linux/amd64 IMAGE
```

Worker использует тот же runtime-образ, что и API. SBOM worker привязан к тому же digest.

## OpenVEX

Документ: `docs/security/openvex.json`. Решения: `docs/security/vulnerability-decisions.json`.

```bash
pnpm ops:openvex
```

`not_affected` требует justification: `component_not_present`, `vulnerable_code_not_in_execute_path`, `vulnerable_code_cannot_be_controlled_by_adversary` или `inline_mitigations_already_exist`. Статус `fixed` допустим только после фактического обновления package. VEX на tag без digest недействителен.

CVE-2026-14456 — очередь входящих каналов OpenSSL QUIC server. ClamAV не вызывает QUIC listener и не слушает UDP. Классификация `NOT_AFFECTED`, justification `vulnerable_code_not_in_execute_path`. Исправленный пакет Debian — `3.5.7-1~deb13u2`; закреплённый образ его ещё не содержит.

CVE-2026-84782 — повтор DTLS handshake по UDP при non-blocking I/O. Обычный HTTPS/TLS по TCP не является DTLS. Классификация `NOT_AFFECTED` с тем же justification.

## Security gate

```bash
pnpm ops:supply-chain
```

Машинный итог: `PASS`, `PARTIAL` или `BLOCKED`. `BLOCKED` запрещает commit и push этого блока. `PARTIAL` допустим, если причина — неподтверждённый registry digest MinIO, непубликованный multi-arch manifest или smoke `BLOCKED_BY_LOCAL_ARCHITECTURE`. Неклассифицированный CRITICAL, `AFFECTED_BLOCKING`, отсутствие SBOM или применимая исправимая HIGH без отдельного решения дают `BLOCKED`.

## Обновление образа

1. Найти официальный patch той же major-линии.
2. Снять manifest list и platform digest через `docker buildx imagetools inspect`.
3. Обновить `image-pins.json` и compose.
4. Повторить Trivy по окончательному digest.
5. Обновить OpenVEX. Не помечать CVE исправленным, пока package в образе не изменился.
6. Прогнать `pnpm ops:supply-chain`.

Major PostgreSQL, Redis, MinIO и API без отдельного обоснования не меняется. Случайный сторонний образ вместо официального не используется.

## Staging

До staging на настоящем `linux/amd64` хосте: повторить smoke API, web, worker и migrator; подтвердить digest MinIO; опубликовать образы только отдельным решением; не считать локальный QEMU заменой этого шага.
