# Операционные определения метрик аналитики

Источник формул: `docs/requirements/QUALITY_ANALYTICS.md` и `packages/domain/src/analytics.ts`.

Часовой пояс расчёта: `Europe/Minsk` (`+03:00`). Версия правил паттернов: `2026.10.05`.

Агрегаты считаются в PostgreSQL. В браузер уходит уже посчитанный ответ и страница drill-down. Кэш агрегатов не используется: изменение дефекта, попытки или финансового влияния видно следующим запросом.

Целевые ориентиры на синтетической выборке до 100 000 дефектов: overview p95 < 1,5 с, drill-down p95 < 1 с. Запросы ограничены `statement_timeout` 4 с.

Индексы: `defect_items(createdAt)`, `defect_items(status, createdAt)`, уникальность `(defectItemId, attemptNumber)`, частичный уникальный индекс одной `PENDING`-попытки, `defect_financial_impacts(status, amountType, payerType, occurredAt)`.

Экспорт CSV в этом контуре нет, поэтому формульной инъекции в выгрузке нет.

`WorkExposure` существует как схема будущего знаменателя и не заполняется.

Подтверждённая затрата Dana — только `DefectFinancialImpact` со статусом `CONFIRMED`, типом `ACTUAL_COST` и плательщиком `COMPANY`. Предложение подрядчика остаётся в `Proposal` и в эту сумму не попадает.
