-- CreateEnum
CREATE TYPE "ActFormCode" AS ENUM ('S1', 'S23');

-- CreateEnum
CREATE TYPE "ActStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DefectItemStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER', 'CONTRACTOR_ENGINEER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrganizationRoleType" AS ENUM ('CUSTOMER', 'LIABLE_CONTRACTOR', 'ALTERNATIVE_CONTRACTOR');

-- CreateEnum
CREATE TYPE "ProposalSlot" AS ENUM ('A', 'B', 'C');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_objects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "commissionedAt" TIMESTAMPTZ(3),
    "warrantyEndsAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "property_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_object_engineers" (
    "id" UUID NOT NULL,
    "propertyObjectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMPTZ(3),

    CONSTRAINT "property_object_engineers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "officialName" TEXT NOT NULL,
    "unp" TEXT,
    "postalAddress" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_role_assignments" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "role" "OrganizationRoleType" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_work_types" (
    "organizationId" UUID NOT NULL,
    "workTypeId" UUID NOT NULL,

    CONSTRAINT "organization_work_types_pkey" PRIMARY KEY ("organizationId","workTypeId")
);

-- CreateTable
CREATE TABLE "defect_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "defect_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acts" (
    "id" UUID NOT NULL,
    "officialNumber" TEXT NOT NULL,
    "formCode" "ActFormCode" NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "objectId" UUID NOT NULL,
    "customerOrganizationId" UUID NOT NULL,
    "signedDocumentRef" TEXT,
    "status" "ActStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancellationReason" TEXT,
    "cancelledByUserId" UUID,

    CONSTRAINT "acts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "act_number_sequences" (
    "formCode" "ActFormCode" NOT NULL,
    "year" INTEGER NOT NULL,
    "lastIssued" INTEGER NOT NULL,

    CONSTRAINT "act_number_sequences_pkey" PRIMARY KEY ("formCode","year")
);

-- CreateTable
CREATE TABLE "defect_items" (
    "id" UUID NOT NULL,
    "actId" UUID NOT NULL,
    "location" TEXT NOT NULL,
    "defectTypeId" UUID NOT NULL,
    "status" "DefectItemStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "claimDetails" TEXT NOT NULL,
    "plannedDeadline" TIMESTAMPTZ(3),
    "claimDeadline" TIMESTAMPTZ(3),
    "readyAt" TIMESTAMPTZ(3),
    "thirdPartyDeadline" TIMESTAMPTZ(3),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "defect_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defect_item_engineers" (
    "defectItemId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "defect_item_engineers_pkey" PRIMARY KEY ("defectItemId","userId")
);

-- CreateTable
CREATE TABLE "defect_item_liable_organizations" (
    "defectItemId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    CONSTRAINT "defect_item_liable_organizations_pkey" PRIMARY KEY ("defectItemId","organizationId")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" UUID NOT NULL,
    "defectItemId" UUID NOT NULL,
    "slot" "ProposalSlot" NOT NULL,
    "alternativeContractorOrganizationId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BYN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "actId" UUID,
    "defectItemId" UUID,
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" UUID NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "requestId" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "deadlineWarningDays" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "organizations_unp_key" ON "organizations"("unp");
CREATE UNIQUE INDEX "organization_role_assignments_organizationId_role_key" ON "organization_role_assignments"("organizationId", "role");
CREATE UNIQUE INDEX "work_types_code_key" ON "work_types"("code");
CREATE UNIQUE INDEX "defect_types_code_key" ON "defect_types"("code");
CREATE UNIQUE INDEX "acts_officialNumber_key" ON "acts"("officialNumber");
CREATE UNIQUE INDEX "acts_formCode_year_sequence_key" ON "acts"("formCode", "year", "sequence");
CREATE UNIQUE INDEX "proposals_defectItemId_slot_key" ON "proposals"("defectItemId", "slot");

CREATE INDEX "property_object_engineers_propertyObjectId_idx" ON "property_object_engineers"("propertyObjectId");
CREATE INDEX "property_object_engineers_userId_idx" ON "property_object_engineers"("userId");
CREATE INDEX "defect_items_actId_idx" ON "defect_items"("actId");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

ALTER TABLE "property_object_engineers" ADD CONSTRAINT "property_object_engineers_propertyObjectId_fkey" FOREIGN KEY ("propertyObjectId") REFERENCES "property_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "property_object_engineers" ADD CONSTRAINT "property_object_engineers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_role_assignments" ADD CONSTRAINT "organization_role_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_work_types" ADD CONSTRAINT "organization_work_types_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_work_types" ADD CONSTRAINT "organization_work_types_workTypeId_fkey" FOREIGN KEY ("workTypeId") REFERENCES "work_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acts" ADD CONSTRAINT "acts_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "property_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acts" ADD CONSTRAINT "acts_customerOrganizationId_fkey" FOREIGN KEY ("customerOrganizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "acts" ADD CONSTRAINT "acts_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_items" ADD CONSTRAINT "defect_items_actId_fkey" FOREIGN KEY ("actId") REFERENCES "acts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_items" ADD CONSTRAINT "defect_items_defectTypeId_fkey" FOREIGN KEY ("defectTypeId") REFERENCES "defect_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_item_engineers" ADD CONSTRAINT "defect_item_engineers_defectItemId_fkey" FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_item_engineers" ADD CONSTRAINT "defect_item_engineers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_item_liable_organizations" ADD CONSTRAINT "defect_item_liable_organizations_defectItemId_fkey" FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defect_item_liable_organizations" ADD CONSTRAINT "defect_item_liable_organizations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_defectItemId_fkey" FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_alternativeContractorOrganizationId_fkey" FOREIGN KEY ("alternativeContractorOrganizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_actId_fkey" FOREIGN KEY ("actId") REFERENCES "acts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_defectItemId_fkey" FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_act_official_number_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."officialNumber" IS DISTINCT FROM OLD."officialNumber" THEN
    RAISE EXCEPTION 'Act official number cannot be changed after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_act_official_number_immutable
BEFORE UPDATE ON "acts"
FOR EACH ROW
EXECUTE FUNCTION prevent_act_official_number_change();

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Audit log records are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_logs_append_only
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_mutation();
