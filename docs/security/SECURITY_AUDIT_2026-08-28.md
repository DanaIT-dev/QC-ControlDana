# Security audit — 2026-08-28

Instrumented SAST/DAST and remediation for the internal Dana Holding product «Реестр дефектных актов СГР». This Markdown file is the audit record. Scanner JSON/Markdown reports stay in gitignored `test-results/security/` and are not committed.

Date of scan: 2026-08-28. Targets were loopback only. No external email, no non-local DAST URL, no production tenant.

## Reproduction

Infrastructure must already be up (`pnpm infra:up`). Do not commit `.env`.

```bash
node scripts/security/check-docker-exposure.mjs
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
bash scripts/security/run-sast.sh
# start local API/Web/worker on 3000/3001/3002, then:
bash scripts/security/run-dast.sh
# production header smoke on extra loopback ports (see below)
bash scripts/security/production-headers-smoke.sh
```

Production header smoke expects API on `127.0.0.1:3011` and Web on `127.0.0.1:3010` with `NODE_ENV=production`, `WEB_ORIGIN=https://localhost:3010`, `PUBLIC_APP_URL=https://localhost:3010`. It does not read `WEB_ORIGIN` from the development `.env`.

Raw reports (gitignored): `test-results/security/`. Scanner cache: user Trivy cache directory, not the repository.

## Scanner versions and immutable digests

All scanner images were pulled with `--platform linux/arm64` and inspected as `arch=arm64 os=linux`.

| Tool                      | Image                            | Digest                                                                    |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Semgrep Community 1.128.1 | `semgrep/semgrep:1.128.1`        | `sha256:fca58525689355641019c05ab49dcc5bc3a1eb7e044f35014ee39594b5aa4fc1` |
| Gitleaks v8.28.0          | `zricethezav/gitleaks:v8.28.0`   | `sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854` |
| Trivy 0.66.0              | `aquasec/trivy:0.66.0`           | `sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e` |
| OWASP ZAP 2.16.1          | `ghcr.io/zaproxy/zaproxy:2.16.1` | `sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab` |

Pin file: `scripts/security/scanners.env`.

## Scope

In scope:

- Application source: `apps/api`, `apps/web`, `apps/worker`, `packages/*`
- Local compose: PostgreSQL, Redis, MinIO, ClamAV, Mailpit
- Local HTTP stand: Web `:3000`, API `:3001`, worker `:3002`
- Databases: development `sgr_registry` and test `sgr_registry_test` only
- Object storage: development bucket plus `S3_TEST_BUCKET`
- Mail: local Mailpit only
- Redis key prefix for tests: `sgr-test`

Out of scope:

- External SMTP, public URLs, non-loopback DAST targets
- Destructive ZAP active scan against development data
- Production cluster images (this environment uses local compose images)
- 1С, SMS, Telegram, WebSocket (1С исключена из проекта, не будущий канал)

## Exclusions

Semgrep ignore: `node_modules/`, `dist/`, `.next/`, `coverage/`, `test-results/`, `playwright-report/`, `pnpm-lock.yaml`.

Gitleaks allowlist: `node_modules`, build outputs, `.env.example`, local compose placeholders, documented demo password placeholder. Reports are redacted (`--redact`). Secrets are not printed in this document.

Trivy filesystem skips `node_modules`, `.next`, `dist`, `coverage`.

ZAP unauthenticated sitemap is generated at runtime under gitignored `test-results/security/zap-sitemap-www/` (HTML with local `host.docker.internal` links only). The helper HTTP server is killed after the scan. Alerts against that helper (missing CSP on port 3999) are not product findings.

## Coverage split

### OWASP ZAP (instrumented DAST)

Unauthenticated `zap-baseline.py` (`-I`, spider 4 minutes, no destructive policy):

- Web origin (`host.docker.internal:3000`): login, static assets, robots/sitemap probes, form GET with ZAP credentials in query. 35 URLs. `FAIL-NEW: 0`.
- API health (`host.docker.internal:3001/api/health`): CSP present (`default-src 'none'`), nosniff, clickjacking headers. `FAIL-NEW: 0`.
- Local sitemap of Web/API paths (login, registry, notifications, deadlines, system-status, act create, health/ready, attachment metadata/content, XSS/SQLi query probes, path traversal). Follows into the running stand. `FAIL-NEW: 0`.

ZAP did not perform authenticated crawling. Authenticated role matrix is the harness below plus application tests.

### Authenticated DAST harness (`scripts/security/dast-authenticated.mjs`)

64 checks, 0 failures, local Web/API only. Roles: ADMIN, SGR_MANAGER, RESPONSIBLE_ENGINEER, CONTRACTOR_ENGINEER.

Covered: unauthenticated registry/notifications/SLA/system-status/attachment metadata and content (401); API/Web CSP; CORS (foreign origin not reflected); open redirect on `login?next=`; login SQLi/XSS; CR/LF header rejection; method confusion on GET login; oversized login body; per-role Web pages; reflected XSS and SQLi in registry search; CSRF required on logout; path traversal on attachments; malicious upload filename; RESPONSIBLE B/C absence on registry, notifications, and act detail.

### Application integration and Playwright

- `apps/api/tests/integration/security.integration.test.ts`: unauthenticated product routes, CORS, SQLi/XSS/header injection via Fastify inject, path traversal, method confusion, CSRF, oversized JSON, RESPONSIBLE B/C leak.
- `apps/api/tests/integration/auth.integration.test.ts`: session idle/absolute TTL, cookie maxAge, CSRF, audit without secrets, API CSP.
- `apps/api/tests/unit/*`: CSPRNG temporary password, compose bind, production cookie/env policy.
- `packages/domain` session lifetime unit tests with controlled timestamps.
- Playwright `apps/web/e2e/security.spec.ts`: login CSP/frame deny, four roles on notifications/deadlines/system-status/registry, XSS search string, no session token in `localStorage`.

### Manual

Not used as a substitute for DAST. Health/ready/worker curls and production header smoke are liveness/header checks only.

## Findings before remediation

From the prior architecture/security review of this codebase (not a previous ZAP run):

| Severity | Count | Item                                                                               |
| -------- | ----- | ---------------------------------------------------------------------------------- |
| Critical | 0     | —                                                                                  |
| High     | 0     | —                                                                                  |
| Medium   | 1     | Compose published PostgreSQL/Redis/MinIO/Mailpit/ClamAV on all interfaces          |
| Low      | 3     | Temporary password modulo bias; Helmet CSP off on JSON API; 30-day sliding session |

## Remediation

### Docker ports

`infra/docker/compose.yaml` publishes PostgreSQL, Redis, MinIO API, MinIO Console, Mailpit, and ClamAV as `127.0.0.1:HOST:CONTAINER`. In-compose clients keep service DNS names. Host processes use localhost.

Checks:

- `node scripts/security/check-docker-exposure.mjs` (compose YAML + `docker port` + Redis not reachable on non-loopback IPv4)
- `apps/api/tests/unit/compose-published-ports.test.ts`

Runtime on this date: published mappings were loopback-only; API `/api/health` and `/api/ready` returned 200.

### Temporary password

`generateTemporaryPassword` uses `crypto.randomInt(0, alphabet.length)` for picks and Fisher–Yates. Alphabet and required character classes are unchanged. Unit tests forbid `Math.random` and `% alphabet.length`. Audit log for user create/reset stores role/email/`mustChangePassword`, not the temporary password. The value is returned once to the ADMIN API caller.

### CSP

API Helmet: `default-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'none'`, `X-Frame-Options: DENY`, nosniff. HSTS only when `NODE_ENV=production`.

Web: nonce CSP in `apps/web/lib/csp.ts` via `apps/web/proxy.ts`. Production script-src has no `unsafe-eval`. Development adds `unsafe-eval` and localhost WebSocket `connect-src`. `frame-ancestors 'none'` and `X-Frame-Options: DENY`. `poweredByHeader: false`. Fonts (`font-src 'self'`), images (`img-src 'self' data: blob:`), attachment download through the authenticated API proxy.

Production smoke on loopback confirmed Web CSP without `unsafe-eval` and API HSTS + JSON CSP.

### Session policy

SameSite remains Lax (email notification links). CSRF remains mandatory on mutations. `Secure` is true only when `NODE_ENV=production` (HTTP localhost may use `Secure=false`).

Idle timeout: `SESSION_IDLE_TIMEOUT_SECONDS`, default 12 hours, refreshed by activity. Absolute lifetime: `SESSION_ABSOLUTE_LIFETIME_SECONDS`, default 7 days, from `createdAt`, not extended by activity. Redis TTL is `min(remaining idle, remaining absolute)`. Password change and logout-all delete sessions. Production env refuses HTTP `WEB_ORIGIN` / `PUBLIC_APP_URL` and idle/absolute above those defaults. Session tokens are HttpOnly cookies, not `localStorage` / `sessionStorage` (UI may store a B/C table toggle in `sessionStorage` only).

## Findings after

Open issues that require a product code fix before declaring the app unsafe: **Critical 0, High 0, Medium 0**.

Tool output still contains items that are classified below as accepted risk, false positive, or local-only infrastructure.

| Source                           | Critical           | High                     | Medium                | Low / Info                         |
| -------------------------------- | ------------------ | ------------------------ | --------------------- | ---------------------------------- |
| Semgrep (product-relevant)       | 0                  | 0                        | 4 supply-chain policy | 1 X-Frame-Options rule (FP)        |
| Gitleaks worktree + full history | 0                  | 0                        | 0                     | 0 leaks                            |
| pnpm audit (all)                 | 0                  | 3                        | 0                     | 0                                  |
| pnpm audit (production)          | 0                  | 3                        | 0                     | 0                                  |
| pnpm audit (dev)                 | 0                  | 1 (deepmerge-ts overlap) | 0                     | 0                                  |
| Trivy filesystem                 | 0                  | 3 (same npm advisories)  | 0                     | —                                  |
| Trivy compose IaC                | 0                  | 0                        | 0                     | 0                                  |
| Trivy `redis:7-alpine`           | 0                  | 0                        | 0                     | 0                                  |
| Trivy local compose OS images    | see accepted risks | see accepted risks       | —                     | —                                  |
| ZAP Web unauth (`FAIL-NEW`)      | 0                  | 0                        | 2 CSP notes (below)   | several informational              |
| ZAP API unauth (`FAIL-NEW`)      | 0                  | 0                        | 0                     | 2 (ZAP outdated, cacheable health) |
| Authenticated harness            | 0                  | 0                        | 0                     | 0                                  |

ZAP Web Medium: `script-src unsafe-eval` on the **development** Next.js server (expected). Production smoke on `:3010` had no `unsafe-eval`. ZAP Web Medium: `style-src unsafe-inline` is present in production CSP for Next.js/shadcn styles; scripts are nonce + `strict-dynamic`.

## Accepted risks

Each item has evidence, a compensating control, an owner, and a review date.

1. **pnpm `minimumReleaseAge` / `trustPolicy` / `blockExoticSubdeps` (Semgrep Medium)**  
   Evidence: enabling 7-day minimum release age blocked current AWS SDK packages in the lockfile; `trustPolicy: no-downgrade` blocked `prisma@7.10.0`.  
   Control: committed lockfile, `pnpm audit` in this audit, no unpinned `latest` installs in CI.  
   Owner: platform. Review: 2026-11-28.

2. **Semgrep `x-frame-options-misconfiguration` on `apps/web/proxy.ts` (WARNING)**  
   Evidence: the header value is the literal `DENY`, not request input. CSP also sets `frame-ancestors 'none'`.  
   Control: static deny + CSP.  
   Owner: web. Review: 2026-11-28.

3. **`image-size` 2.0.2 — GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq (High, no published patch on npm for `<=2.0.2`)**  
   Evidence: ICNS / JXL / HEIF parsers. Upload path runs magic+MIME allowlist (`assertAllowedFile`) before `imageSize`, and only `image/*` that already passed jpeg/png/webp are parsed. ICNS/JXL/HEIF are not accepted.  
   Control: allowlist and size/pixel caps.  
   Owner: api/attachments. Review: 2026-11-28 or when an approved patched fork exists.

4. **`deepmerge-ts` 7.1.5 via Prisma config (High, fix `>=8.0.0` exists but not on the Prisma 7.10.0 nested tree)**  
   Evidence: path is `prisma` → `@prisma/config` → `deepmerge-ts`. Not reachable from HTTP handlers.  
   Control: Prisma is a build/migrate dependency, not a request parser.  
   Owner: platform. Review: 2026-11-28 (Prisma upgrade).

5. **Local compose OS CVEs on `postgres:18`, `minio/minio:RELEASE.2025-04-22T22-12-26Z`, `clamav/clamav-debian:1.4@sha256:f6da737f9399d6a1851c463b2f88d02021a67f969ec42dd6e1751fecf7c3de4f`, `axllent/mailpit:v1.27.10@sha256:b1f1be18af530d939a11ee8820b379e0c88eeec204d904bfad68862adced3a5a`**  
   Evidence: Trivy image scans report many Critical/High in distro packages. These images are for local development, published only on loopback. Redis Alpine image had 0 vulnerabilities.  
   Control: loopback bind; not production app images.  
   Owner: platform. Review: 2026-11-28 (pin/refresh local images).

6. **Redis without AUTH on localhost**  
   Evidence: local compose Redis has no password. Not published off loopback.  
   Control: loopback-only publish; production must use authenticated Redis.  
   Owner: platform. Review: 2026-11-28.

7. **Cookie `SameSite=Lax` (not Strict)**  
   Evidence: notification emails link into the app; Lax is required for that top-level GET. CSRF tokens remain mandatory on mutations.  
   Control: CSRF + origin checks.  
   Owner: api/auth. Review: 2026-11-28.

8. **Web CSP `style-src 'unsafe-inline'`**  
   Evidence: required for current Next.js / Tailwind / shadcn styling. Script policy is nonce-based without production `unsafe-eval`.  
   Control: script nonce, `object-src 'none'`, `frame-ancestors 'none'`.  
   Owner: web. Review: 2026-11-28.

9. **ZAP informational / Low on development Web** (missing Permissions-Policy, Unix timestamps in vendor chunks, cache-control on static, ZAP scanner outdated, Spectre isolation on static assets, GET login with credentials in query produced by ZAP itself).  
   Evidence: no `FAIL-NEW`; login is POST JSON to the API, not a GET password form.  
   Control: production headers smoke; authentication is POST `/api/auth/login`.  
   Owner: web. Review: 2026-11-28.

## Quality gate (this date)

| Check                                                                                       | Result                              |
| ------------------------------------------------------------------------------------------- | ----------------------------------- |
| `pnpm format:check`                                                                         | passed                              |
| `pnpm lint`                                                                                 | passed                              |
| `pnpm typecheck`                                                                            | passed                              |
| `pnpm test`                                                                                 | 71 + 5 + 28 + 26 passed, 0 skipped  |
| `pnpm test:integration`                                                                     | 4 + 61 passed, 0 skipped            |
| `pnpm test:e2e`                                                                             | 39 passed, 0 skipped                |
| `pnpm build`                                                                                | passed                              |
| Semgrep Community configs: typescript, nodejs, react, nextjs, owasp-top-ten, security-audit | executed                            |
| Gitleaks worktree + `--log-opts=--all`                                                      | no leaks                            |
| `pnpm audit` prod / dev / all                                                               | executed                            |
| Trivy fs + compose config + compose images                                                  | executed                            |
| OWASP ZAP baseline + authenticated harness                                                  | executed, local only, harness 64/64 |
| Docker port exposure                                                                        | passed                              |
| Production security headers smoke                                                           | passed                              |
| API health 200, ready 200, worker health 200                                                | passed                              |
| Migrations development + test                                                               | up to date, 6 migrations            |

Product tests must not use `it.skip` / Playwright skip to hide failures.

## Runtime notes

- Applications inside Compose use service names; host-run API/worker use `localhost` / `127.0.0.1`.
- DAST and Playwright used the local demo directory and Mailpit. SMTP did not leave the machine.
- Stop API/Web/worker processes started for scans; leave Compose up if other work continues.
