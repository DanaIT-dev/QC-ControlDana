# Контракт вложений

Безопасный контур файлов для Акта, DefectItem и Proposal. Bucket MinIO полностью приватный. Браузер не получает ключи, endpoint или постоянные object URL.

## Владельцы и XOR

Один `Attachment` принадлежит ровно одному владельцу: `actId` **или** `defectItemId` **или** `proposalId`. Инвариант закреплён CHECK-ограничением в PostgreSQL, не только TypeScript.

## Статусы

`UPLOADING` → `PENDING_SCAN` → `SCANNING` → `READY` | `REJECTED` | `SCAN_FAILED`. `ARCHIVED` скрывает файл из обычного списка, metadata и AuditLog сохраняются. Скачивание разрешено только для `READY`.

## Категории

- Act: `ACT_DOCUMENT`, `ACT_SCAN`, `OTHER`
- DefectItem: `DEFECT_PHOTO`, `CLAIM_DOCUMENT`, `THIRD_PARTY_DOCUMENT`, `OTHER`
- Proposal: `PROPOSAL_DOCUMENT` (slot наследуется от Proposal, отдельно не передаётся)

## Роли

ADMIN и SGR_MANAGER загружают Act/Defect/Proposal A/B/C, скачивают READY, архивируют доступные.

CONTRACTOR видит Act и доступные Defect/Proposal A/B/C; загружает `THIRD_PARTY_DOCUMENT` и `PROPOSAL_DOCUMENT`; не видит сумму Proposal A.

RESPONSIBLE видит Act-документы акта закреплённого объекта, вложения всех DefectItem этого акта и Proposal A. B/C вложения и события отсутствуют. Direct ID вне scope → тот же 404, что несуществующая запись.

## MinIO

Ключ объекта: `attachments/{uuid}`. Оригинальное имя не входит в key. Загрузка stream через API (`multipart/form-data`), не presigned PUT. Development bucket `sgr-attachments`, test `sgr-attachments-test`. Integration tests отказываются работать с bucket без суффикса `-test`.

## Форматы и лимиты

PDF, JPEG, PNG, WebP. Максимум 20 МиБ и 50 активных вложений на владельца. Запрещены SVG, HTML, XML, JS, executable, архивы, Office. Проверяются extension, declared MIME и magic bytes. Zero-byte и MIME mismatch отклоняются.

## ClamAV

Worker job `attachment.scan` стримит объект в clamd INSTREAM. CLEAN → READY. INFECTED → REJECTED, bytes удаляются, objectKey очищается. Ошибки: bounded retry, затем SCAN_FAILED. Production scan не отключается. Первый запуск ClamAV качает сигнатуры и может занять несколько минут.

Локальный образ закреплён по digest (`clamav/clamav-debian:1.4@sha256:…`, index включает `linux/arm64`). Команда обновления digest — в [LOCAL_DEVELOPMENT.md](../runbooks/LOCAL_DEVELOPMENT.md).

## Миграция stub-таблицы

`20260827160000_attachments_and_file_security` заменяет только неиспользовавшийся пустой stub `attachments` из init. Если старой таблицы нет — миграция продолжается; если она пуста — DROP и новая схема; если есть хотя бы одна строка — миграция останавливается до DROP с ошибкой. Молчаливой потери данных нет.

## API

- `GET/POST /api/acts/:actId/attachments`
- `GET/POST /api/defects/:defectItemId/attachments`
- `GET/POST /api/proposals/:proposalId/attachments`
- `GET /api/attachments/:id`
- `GET /api/attachments/:id/content` — stream, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, безопасный Content-Disposition
- `POST /api/attachments/:id/archive` — CSRF, expectedVersion, причина

Upload отвечает 202 со статусом `PENDING_SCAN`.

## История

События: `ATTACHMENT_UPLOADED`, `ATTACHMENT_SCAN_PASSED`, `ATTACHMENT_REJECTED`, `ATTACHMENT_SCAN_FAILED`, `ATTACHMENT_ARCHIVED`. RESPONSIBLE не видит B/C. AuditLog не содержит bytes, credentials, objectKey, raw scanner response.

## Тесты

ClamAV не детектирует EICAR внутри PDF (спецификация EICAR — точный COM-файл). HTTP-отклонение проверяется тестовой сигнатурой `Sgr.Test.PdfThreat` (`infra/docker/clamav/sgr-test.ndb`). Точный EICAR генерируется в тестах динамически и сканируется через INSTREAM.

Production: TLS на object storage, приватный bucket, секретные ключи только на API/worker.
