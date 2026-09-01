# Security audit — 2026-09-01

Instrumented SAST/DAST and remediation for the internal Dana Holding product «Реестр дефектных актов СГР». Scanner JSON/Markdown reports stay in gitignored `test-results/security-audit/` and are not committed.

Date of scan: 2026-09-01. Targets were loopback only. No external email, no non-local DAST URL, no production tenant.

Previous instrumented audit: [SECURITY_AUDIT_2026-08-28.md](./SECURITY_AUDIT_2026-08-28.md). This run also covers PostgreSQL FORCE RLS, act chat, and authenticated DAST on an isolated disposable database.

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
bash scripts/security/run-isolated-dast.sh
```

Raw reports (gitignored): `test-results/security-audit/`. Scanner cache: user Trivy cache directory, not the repository.

Isolated DAST uses PostgreSQL database `sgr_security_audit_test`, Redis logical DB 15 with prefix `sgr-audit`, MinIO bucket `sgr-audit-attachments`, and loopback ports 3100/3101/3102. The disposable database is dropped after the scan. Development `sgr_registry` and test `sgr_registry_test` are not reset.

## Scanner versions and immutable digests

All scanner images were pulled with `--platform linux/arm64`.

| Tool                      | Image                            | Digest                                                                    |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Semgrep Community 1.128.1 | `semgrep/semgrep:1.128.1`        | `sha256:fca58525689355641019c05ab49dcc5bc3a1eb7e044f35014ee39594b5aa4fc1` |
| Gitleaks v8.28.0          | `zricethezav/gitleaks:v8.28.0`   | `sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854` |
| Trivy 0.66.0              | `aquasec/trivy:0.66.0`           | `sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e` |
| OWASP ZAP 2.16.1          | `ghcr.io/zaproxy/zaproxy:2.16.1` | `sha256:7840969c7c9fead565bf9734b12f49f6886db90b1d35b1f74d79710bbd081dab` |
| pnpm audit                | pnpm 11.24.0                     | lockfile-local                                                            |

Pin file: `scripts/security/scanners.env`.

OSV Scanner container was not present locally. Dependency coverage is `pnpm audit` plus Trivy filesystem (equivalent for this repository).

## Scope

In scope:

- Application source: `apps/api`, `apps/web`, `apps/worker`, `packages/*`
- Local compose: PostgreSQL, Redis, MinIO, ClamAV, Mailpit
- Isolated DAST stand: Web `:3100`, API `:3101`, worker `:3102`
- Disposable database `sgr_security_audit_test` with synthetic seed users of all four roles
- Object storage: dedicated audit bucket
- Mail: local Mailpit only
- Redis: logical DB 15, prefix `sgr-audit`

Out of scope:

- External SMTP, public URLs, non-loopback DAST targets
- Production cluster images (this environment uses local compose images)
- 1С, SMS, Telegram, WebSocket, Web Push
- DoS, stress, unlimited fuzzing, cloud metadata probes

## Threat model (summary)

Assets: users and roles; Redis sessions and CSRF tokens; acts, defects, proposal A/B/C; internal act chat; notifications; attachments and MinIO; AuditLog; PostgreSQL; RLS HMAC secret; SMTP credentials; worker/outbox; configuration.

Trust boundaries: Browser → Next.js BFF → NestJS API → PostgreSQL/Redis/MinIO; worker → PostgreSQL/Redis/SMTP (Mailpit locally); ADMIN/SGR_MANAGER vs object-scoped RESPONSIBLE_ENGINEER vs CONTRACTOR_ENGINEER.

Principal threats reviewed: privilege escalation; object/act IDOR; RLS/context forgery; B/C leak to responsible; contractor history/chat; authorId/userId/objectId tampering; session fixation/theft; CSRF; XSS; SQL injection; SSRF; path traversal; upload/ClamAV; secret leakage; outbox replay; SMTP header injection; mass assignment; open redirect; error leakage.

## Findings after this audit

Open product issues that require a code fix before declaring the app unsafe: **Critical 0, High 0**. Confirmed Medium items from this run were remediated (see below). Remaining items are accepted residual risk, false positives, or local-only infrastructure.

### Remediated in this commit

| Severity | CWE / OWASP                      | Component                                  | Status |
| -------- | -------------------------------- | ------------------------------------------ | ------ |
| High     | CWE-863 / A01                    | Attachment RLS writes                      | Fixed  |
| High     | CWE-863 / A01                    | Contractor `defect_items` UPDATE           | Fixed  |
| Medium   | CWE-307 / A07                    | Login rate limit email∧IP only             | Fixed  |
| Medium   | CWE-770 / A04                    | JSON bodyLimit on login                    | Fixed  |
| Medium   | CWE-1284 / A04                   | Login email unbounded                      | Fixed  |
| Medium   | CWE-352 / A01 (defense in depth) | Missing Origin allowed                     | Fixed  |
| Medium   | CWE-22 / A10                     | Next.js BFF `..` path confusion            | Fixed  |
| Low      | CWE-693 / A05                    | Missing Permissions-Policy                 | Fixed  |
| Medium   | CWE-306 / A07                    | Redis without AUTH                         | Fixed  |
| High     | CWE-200 / A01                    | `users.passwordHash` readable by `sgr_app` | Fixed  |
| Medium   | CWE-863 / A01                    | `sla_clocks` write wider than object scope | Fixed  |

Attachment INSERT/UPDATE/DELETE for `sgr_app` now uses `sgr_attachment_visible` (same object/slot predicate as SELECT). Responsible cannot mutate proposal B/C rows via SQL. CONTRACTOR_ENGINEER UPDATE on `defect_items` is limited by trigger `sgr_guard_contractor_defect_update` to `thirdPartyDeadline` plus bookkeeping columns.

Login throttling uses separate Redis counters for account and IP. JSON routes cap bodies at 64 KiB; multipart upload routes keep the attachment limit. Login DTO is `.strict()` with email max 254. Browser mutations require `Origin === WEB_ORIGIN` or a `Referer` whose origin matches. The Web BFF rejects `.` / `..` path segments and keeps upstream URLs under `/api`.

### Scanner output classification

| Source                           | Critical | High              | Medium                  | Low / Info                             |
| -------------------------------- | -------- | ----------------- | ----------------------- | -------------------------------------- |
| Semgrep (product-relevant)       | 0        | 0                 | 4 supply-chain policy   | X-Frame-Options FP; test `<script>` FP |
| Gitleaks worktree + full history | 0        | 0                 | 0                       | 0 leaks                                |
| pnpm audit (production)          | 0        | 3 (see residuals) | 0                       | 0                                      |
| Trivy filesystem                 | 0        | 3 npm advisories  | 1 mysql2 via Prisma CLI | —                                      |
| Trivy compose IaC                | 0        | 0                 | 0                       | 0                                      |
| Trivy `redis:7-alpine`           | 0        | 0                 | 0                       | 0                                      |
| Trivy local compose OS images    | accepted | accepted          | accepted                | local loopback only                    |
| Authenticated DAST harness       | 0        | 0                 | 0                       | see DAST section                       |

Semgrep `npm-missing-minimum-release-age` / `pnpm-trust-policy` / `blockExoticSubdeps`: enabling 7-day minimum release age previously blocked current AWS SDK packages; `trustPolicy: no-downgrade` blocked `prisma@7.10.0`. Accepted residual. Control: committed lockfile, `pnpm audit` in this audit.

Semgrep `x-frame-options-misconfiguration` on `apps/web/proxy.ts`: header value is literal `DENY`, not request input. CSP also sets `frame-ancestors 'none'`. False positive.

Semgrep script-tag warnings in `act-chat.integration.test.ts`: test payloads, not product HTML. False positive.

## Accepted residual risks

1. **`image-size` 2.0.2** (High, no published patch for `<=2.0.2`). Upload path allowlists jpeg/png/webp magic before `imageSize`. ICNS/JXL/HEIF are not accepted. Owner: api/attachments. Review: 2026-12-01.

2. **`deepmerge-ts` via Prisma config** (High, fix `>=8.0.0` exists on a Prisma nested tree not yet taken). Not reachable from HTTP handlers. Owner: platform. Review: 2026-12-01.

3. **`mysql2` via Prisma CLI/Studio** (Medium, Trivy fs). Not imported by API/worker request paths. Owner: platform.

4. **Local compose OS CVEs** on postgres/minio/clamav/mailpit images. Loopback publish only; not production app images. Owner: platform.

5. **Local Redis is published on loopback** so host-run API/worker can connect. Production compose does not publish Redis. Passwords are gitignored Docker secret files, not container `Env` / redis-server argv.

6. **Cookie `SameSite=Lax`.** Required for email notification top-level GET. CSRF remains mandatory on mutations.

7. **Web CSP `style-src 'unsafe-inline'`.** Required for Next.js / Tailwind / shadcn. Script policy is nonce-based without production `unsafe-eval`.

8. **Developer workstation holds local Redis secret files** under gitignored `infra/docker/secrets/`. They must never be committed. Production uses orchestrator secrets.

9. **BullMQ requires Redis `EVAL`/`EVALSHA`.** Runtime ACL includes `+@scripting` and `+config|get` for BullMQ Lua; `CONFIG SET`, `FLUSHALL`, `FLUSHDB`, `SHUTDOWN`, `DEBUG`, `MODULE` remain denied.

10. **`TRUST_PROXY`.** Default false. If enabled without a proxy that overwrites `X-Forwarded-For`, login IP limits can be spoofed.

11. **PDF `Content-Disposition: inline`.** Residual PDF-reader script risk; React DOM XSS not involved. `frame-src 'none'` blocks in-app iframe preview.

12. **Concurrent sessions.** Re-login does not revoke other devices until logout-all / password / role / archive.

## Access review (manual + tests)

| Actor                  | Result                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| Unauthenticated        | Product routes 401; health/ready remain public                      |
| ADMIN / SGR_MANAGER    | Registry, chat, history within capabilities                         |
| RESPONSIBLE_ENGINEER   | Assigned objects only; no proposal B/C; chat on assigned acts       |
| CONTRACTOR_ENGINEER    | No history, no act chat (API 403, RLS empty); B/C proposals allowed |
| Foreign act/object IDs | Safe 404 for scoped resources                                       |
| Chat mention           | Does not grant act access                                           |
| Unassign / reassign    | Chat access follows active `PropertyObjectEngineer`                 |
| No RLS context         | Empty SELECT; mutations fail                                        |
| Direct SQL contractor  | Chat hidden; non-deadline defect UPDATE rejected after this audit   |

## DAST

Exact targets: `http://127.0.0.1:3100` (Web) and `http://127.0.0.1:3101` (API). Isolated database `sgr_security_audit_test` (dropped after the scan). Redis DB 15 / prefix `sgr-audit`. MinIO bucket `sgr-audit-attachments`. Mailpit only. External targets contacted: no.

Unauthenticated OWASP ZAP baseline (`zap-baseline.py`, spider 4 minutes, `-I`, no destructive policy):

| Target                       | FAIL-NEW | Notes                                                                                     |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| Web `:3100`                  | 0        | Development CSP still includes `script-src 'unsafe-eval'` and `style-src 'unsafe-inline'` |
| API `:3101/api/health`       | 0        | JSON CSP `default-src 'none'`; Low/Info only                                              |
| Local sitemap helper `:3999` | 0        | WARN on the helper itself (no CSP). Not a product finding                                 |

Authenticated harness: 72 checks, 0 failures. Roles: ADMIN, SGR_MANAGER, RESPONSIBLE_ENGINEER, CONTRACTOR_ENGINEER. Covered unauthenticated product routes including chat; API/Web CSP, Permissions-Policy, CORS, open redirect, login SQLi/XSS/unknown fields/missing Origin/oversize JSON 413, CSRF on logout, path traversal, malicious upload filename, RESPONSIBLE B/C absence, contractor chat 403 without message bodies, authorId tamper rejected.

Duration: ~90 seconds of authenticated checks plus three ZAP baseline spiders. Request volume bounded by ZAP `-m 4` and the harness. Health-check flooding and DoS rules were not used.

## Quality gate (this date)

Recorded after remediation and the isolated DAST pass.

| Check                        | Result                    |
| ---------------------------- | ------------------------- |
| `pnpm format:check`          | passed                    |
| `pnpm lint`                  | passed                    |
| `pnpm typecheck`             | passed                    |
| `pnpm test`                  | passed, 0 skipped         |
| `pnpm test:integration`      | passed, 0 skipped         |
| `pnpm test:e2e`              | 65 passed, 0 skipped      |
| `pnpm build`                 | passed                    |
| Semgrep Community configs    | executed                  |
| Gitleaks worktree + `--all`  | no leaks                  |
| `pnpm audit`                 | executed                  |
| Trivy fs + compose + images  | executed                  |
| Isolated OWASP ZAP + harness | executed, local only      |
| Docker port exposure         | loopback-only (unchanged) |

Product tests must not use `it.skip` / Playwright skip to hide failures.
