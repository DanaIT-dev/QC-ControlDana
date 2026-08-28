-- Notification, SLA clocks, outbox and email delivery. Do not edit earlier migrations.

CREATE TYPE "SlaClockKind" AS ENUM ('GENERAL', 'THIRD_PARTY');
CREATE TYPE "SlaClockState" AS ENUM (
  'NO_DEADLINE',
  'NORMAL',
  'WARNING',
  'DUE_TODAY',
  'OVERDUE',
  'COMPLETED'
);
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PROCESSED', 'FAILED', 'DEAD');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'DEAD');

ALTER TABLE "system_settings"
  ADD COLUMN "escalationDays" INTEGER[] NOT NULL DEFAULT ARRAY[0, 3, 7, 14],
  ADD COLUMN "dailyEvaluationMinuteOfDay" INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "sla_clocks" (
  "id" UUID NOT NULL,
  "defectItemId" UUID NOT NULL,
  "kind" "SlaClockKind" NOT NULL,
  "deadline" TIMESTAMPTZ(3),
  "cycle" INTEGER NOT NULL DEFAULT 1,
  "state" "SlaClockState" NOT NULL,
  "lastEvaluatedBusinessDate" TEXT,
  "satisfiedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "sla_clocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sla_clocks_defectItemId_kind_key" ON "sla_clocks"("defectItemId", "kind");
CREATE INDEX "sla_clocks_kind_state_deadline_idx" ON "sla_clocks"("kind", "state", "deadline");
CREATE INDEX "sla_clocks_lastEvaluatedBusinessDate_idx" ON "sla_clocks"("lastEvaluatedBusinessDate");
ALTER TABLE "sla_clocks" ADD CONSTRAINT "sla_clocks_defectItemId_fkey"
  FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" TIMESTAMPTZ(3),
  "claimedBy" TEXT,
  "processedAt" TIMESTAMPTZ(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

CREATE TABLE "notification_events" (
  "id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "occurrenceKey" TEXT NOT NULL,
  "actorUserId" UUID,
  "actId" UUID,
  "defectItemId" UUID,
  "attachmentId" UUID,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_events_occurrenceKey_key" ON "notification_events"("occurrenceKey");
CREATE INDEX "notification_events_occurredAt_idx" ON "notification_events"("occurredAt");
CREATE INDEX "notification_events_actId_occurredAt_idx" ON "notification_events"("actId", "occurredAt");
CREATE INDEX "notification_events_defectItemId_idx" ON "notification_events"("defectItemId");
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_defectItemId_fkey"
  FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_actId_fkey"
  FOREIGN KEY ("actId") REFERENCES "acts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "notification_recipients" (
  "id" UUID NOT NULL,
  "notificationEventId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "readAt" TIMESTAMPTZ(3),
  "archivedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_recipients_notificationEventId_userId_key"
  ON "notification_recipients"("notificationEventId", "userId");
CREATE INDEX "notification_recipients_userId_readAt_createdAt_idx"
  ON "notification_recipients"("userId", "readAt", "createdAt");
CREATE INDEX "notification_recipients_userId_revokedAt_createdAt_idx"
  ON "notification_recipients"("userId", "revokedAt", "createdAt");
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notificationEventId_fkey"
  FOREIGN KEY ("notificationEventId") REFERENCES "notification_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "email_deliveries" (
  "id" UUID NOT NULL,
  "notificationRecipientId" UUID NOT NULL,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMPTZ(3),
  "providerMessageId" TEXT,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_deliveries_notificationRecipientId_key" ON "email_deliveries"("notificationRecipientId");
CREATE INDEX "email_deliveries_status_nextAttemptAt_idx" ON "email_deliveries"("status", "nextAttemptAt");
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notificationRecipientId_fkey"
  FOREIGN KEY ("notificationRecipientId") REFERENCES "notification_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "sla_evaluation_state" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "lastSuccessfulBusinessDate" TEXT,
  "lastRunAt" TIMESTAMPTZ(3),
  "lastStatus" TEXT,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "sla_evaluation_state_pkey" PRIMARY KEY ("id")
);

INSERT INTO "sla_evaluation_state" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP);

INSERT INTO "sla_clocks" (
  "id", "defectItemId", "kind", "deadline", "cycle", "state", "version", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), d.id, 'GENERAL'::"SlaClockKind",
  COALESCE(d."claimDeadline", d."plannedDeadline"),
  1,
  CASE
    WHEN d.status = 'COMPLETED' THEN 'COMPLETED'::"SlaClockState"
    WHEN COALESCE(d."claimDeadline", d."plannedDeadline") IS NULL THEN 'NO_DEADLINE'::"SlaClockState"
    ELSE 'NORMAL'::"SlaClockState"
  END,
  1, NOW(), NOW()
FROM defect_items d;

INSERT INTO "sla_clocks" (
  "id", "defectItemId", "kind", "deadline", "cycle", "state", "version", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), d.id, 'THIRD_PARTY'::"SlaClockKind",
  d."thirdPartyDeadline",
  1,
  CASE
    WHEN d.status = 'COMPLETED' THEN 'COMPLETED'::"SlaClockState"
    WHEN d."thirdPartyDeadline" IS NULL THEN 'NO_DEADLINE'::"SlaClockState"
    ELSE 'NORMAL'::"SlaClockState"
  END,
  1, NOW(), NOW()
FROM defect_items d;
