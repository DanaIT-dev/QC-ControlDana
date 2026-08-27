-- Operational workflow: versions, archive timestamps, password policy flags,
-- proposal lifecycle, idempotency, audit metadata. Do not edit earlier migrations.

CREATE TYPE "ProposalStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "AuditSource" AS ENUM ('WEB');

ALTER TABLE "users"
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "property_objects"
ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "organizations"
ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "work_types"
ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "defect_types"
ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "acts"
ADD COLUMN "issuedOn" TIMESTAMPTZ(3);

UPDATE "acts" SET "issuedOn" = "createdAt" WHERE "issuedOn" IS NULL;

ALTER TABLE "acts"
ALTER COLUMN "issuedOn" SET NOT NULL;

ALTER TABLE "proposals"
ADD COLUMN "status" "ProposalStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN "archiveReason" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_defectItemId_slot_key";

CREATE UNIQUE INDEX "proposals_active_slot_unique"
ON "proposals" ("defectItemId", "slot")
WHERE "status" = 'ACTIVE';

CREATE INDEX "proposals_defectItemId_slot_status_idx"
ON "proposals" ("defectItemId", "slot", "status");

ALTER TABLE "audit_logs"
ADD COLUMN "actorName" TEXT,
ADD COLUMN "parentEntityType" TEXT,
ADD COLUMN "parentEntityId" TEXT,
ADD COLUMN "reason" TEXT,
ADD COLUMN "source" "AuditSource" NOT NULL DEFAULT 'WEB';

DROP INDEX IF EXISTS "audit_logs_entityType_entityId_idx";
CREATE INDEX "audit_logs_entityType_entityId_occurredAt_idx"
ON "audit_logs" ("entityType", "entityId", "occurredAt");
CREATE INDEX "audit_logs_parentEntityType_parentEntityId_occurredAt_idx"
ON "audit_logs" ("parentEntityType", "parentEntityId", "occurredAt");

CREATE INDEX "users_role_status_idx" ON "users" ("role", "status");
CREATE INDEX "users_status_createdAt_idx" ON "users" ("status", "createdAt");
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" (lower("email"));

CREATE INDEX "property_objects_active_name_idx" ON "property_objects" ("active", "name");
CREATE UNIQUE INDEX "property_objects_name_lower_unique" ON "property_objects" (lower("name"));

CREATE INDEX "organizations_active_officialName_idx" ON "organizations" ("active", "officialName");
CREATE UNIQUE INDEX "organizations_officialName_lower_unique" ON "organizations" (lower("officialName"));

CREATE INDEX "work_types_active_sortOrder_idx" ON "work_types" ("active", "sortOrder");
CREATE UNIQUE INDEX "work_types_name_lower_unique" ON "work_types" (lower("name"));
CREATE UNIQUE INDEX "work_types_code_lower_unique" ON "work_types" (lower("code"));

CREATE INDEX "defect_types_active_sortOrder_idx" ON "defect_types" ("active", "sortOrder");
CREATE UNIQUE INDEX "defect_types_name_lower_unique" ON "defect_types" (lower("name"));
CREATE UNIQUE INDEX "defect_types_code_lower_unique" ON "defect_types" (lower("code"));

UPDATE "property_objects" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "active" = false AND "archivedAt" IS NULL;
UPDATE "organizations" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "active" = false AND "archivedAt" IS NULL;
UPDATE "work_types" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "active" = false AND "archivedAt" IS NULL;
UPDATE "defect_types" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "active" = false AND "archivedAt" IS NULL;

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "resourceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "idempotency_records_actor_command_key_unique"
ON "idempotency_records" ("actorUserId", "command", "idempotencyKey");
CREATE INDEX "idempotency_records_createdAt_idx" ON "idempotency_records" ("createdAt");

ALTER TABLE "idempotency_records"
ADD CONSTRAINT "idempotency_records_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_act_official_number_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."officialNumber" IS DISTINCT FROM OLD."officialNumber"
     OR NEW."formCode" IS DISTINCT FROM OLD."formCode"
     OR NEW."year" IS DISTINCT FROM OLD."year"
     OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
    RAISE EXCEPTION 'Act official number and form identity cannot be changed after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
