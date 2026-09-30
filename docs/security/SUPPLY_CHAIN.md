# Цепочка поставки production-образов

Целевая архитектура production и staging — `linux/amd64`. `linux/arm64` остаётся локальной машиной разработки. Multi-arch manifest не требуется и не является блокером. Локальная проверка через QEMU не подтверждает amd64 staging.

Каталог digest: `infra/docker/image-pins.json`. Дата проверки vendor manifest list — `2026-09-30`. Объектное хранилище — официальный `rustfs/rustfs:1.0.0`, manifest list `sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`, `linux/amd64` `sha256:ba0a1b53e36f321c0d46f3867104abef169f7bc59c467c664ddac87e7ddc9a8b`.

Manifest digest не равен platform digest. Git SHA не равен Docker digest. Локальный image id не равен digest, опубликованному в registry. Отсутствие `FixedVersion` не означает отсутствие риска. Закрытый порт не устраняет уязвимость package. VEX требует доказательства runtime applicability.

## Четыре разные операции

- local single-platform validation: сборка и smoke на машине разработчика, в том числе amd64 через buildx/QEMU.
- multi-platform build: `docker buildx build --platform linux/amd64,linux/arm64` без `docker load` как доказательства manifest.
- registry publication: собственный amd64 release candidate публикуется workflow `.github/workflows/release-candidate.yml` в GHCR. Multi-arch manifest не требуется.
- staging deployment: только после подписи и smoke на реальном `x86_64`. Digest объектного хранилища подтверждён. Production deployment не начат. Подписанный release candidate не опубликован.

`docker load` не доказывает multi-arch manifest: локальный image store хранит одну платформу на tag.

## Digest

Предпочтительная ссылка для образа с подтверждённым manifest list:

```text
repository:version@sha256:<multi-arch-manifest-digest>
platform: ${SGR_PLATFORM:-linux/amd64}
```

Объектное хранилище закреплено digest manifest list в compose. Platform digest в compose не подставляется. Локальный image id не используется как доказательство amd64.

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

Машинный итог: `PASS`, `PARTIAL` или `BLOCKED`. `BLOCKED` запрещает commit и push этого блока. `PARTIAL` допустим, если причина — неподтверждённый `linux/amd64` digest MinIO, отсутствие опубликованного release record или smoke не на реальном `x86_64`. Multi-arch manifest не входит в причины. Неклассифицированный CRITICAL, `AFFECTED_BLOCKING`, отсутствие SBOM или применимая исправимая HIGH без отдельного решения дают `BLOCKED`. Применимый CRITICAL со статусом `ACCEPTED_TEMPORARILY` без risk owner не даёт `PASS` и не открывает production.

## Обновление образа

1. Найти официальный patch той же major-линии.
2. Снять manifest list и platform digest через `docker buildx imagetools inspect`.
3. Обновить `image-pins.json` и compose.
4. Повторить Trivy по окончательному digest.
5. Обновить OpenVEX. Не помечать CVE исправленным, пока package в образе не изменился.
6. Прогнать `pnpm ops:supply-chain`.

Major PostgreSQL, Redis, MinIO и API без отдельного обоснования не меняется. Случайный сторонний образ вместо официального не используется.

## Порядок source SHA

Образы собираются только после commit, который добавляет release workflow. В OCI label передаётся SHA этого commit. Digest образов не коммитится обратно в Git: иначе следующий commit снова сменит revision. Release manifest, SBOM, provenance и release-bound OpenVEX хранятся как OCI referrers, GitHub Actions artifacts или GitHub release.

`docs/security/openvex.json` — policy assessment. Он не является release-bound VEX, пока product id не равен опубликованному digest финального образа. `NOT_AFFECTED` с базового образа не переносится на финальный образ без проверки runtime path.

## Staging

Runbook: `docs/runbooks/AMD64_RELEASE_CANDIDATE.md`. Staging compose — `infra/docker/compose.staging.yaml`. Он фиксирует `platform: linux/amd64`, не содержит `build:` и не использует `latest`. Deployable manifest не выпускается, пока официальный `linux/amd64` digest MinIO не подтверждён. CVE-2026-6653 в ClamAV достижим через загружаемый файл и без утверждённого risk owner держит production gate закрытым. QEMU smoke не заменяет staging на `x86_64`.
