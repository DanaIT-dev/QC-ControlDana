# Мониторинг

Минимальный контур — self-hosted. Правила лежат в `infra/monitoring/alerts.yml`. Сам Prometheus в этом репозитории не разворачивается и не считается запущенным production-мониторингом.

Пробы:

- Web и API: `/login` не должен отвечать 5xx, API `GET /api/health` и `GET /api/ready`.
- PostgreSQL, Redis, MinIO и ClamAV входят в readiness.
- Worker heartbeat и глубина outbox читаются system-status.
- Диск, свежесть backup и срок TLS-сертификата снимаются с хоста и exporter, не из приложения.

Алерты: API недоступен, база недоступна, диск выше 80% и выше 90%, backup старше 36 часов, worker остановлен, outbox backlog, повторяющиеся 5xx, сертификат истекает раньше чем через 21 день.

Логи API — JSON: `timestamp`, `service`, `level`, `event`, `requestId`, `statusCode`, `errorCode`. Текст исключения проходит `redactLogText`. В лог не попадают пароли, `passwordHash`, session id, cookie, CSRF, SMTP password, строки подключения и содержимое вложений. Неудачный вход не пишет email и пароль.
