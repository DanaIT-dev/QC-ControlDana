-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM (
  'UPLOADING',
  'PENDING_SCAN',
  'SCANNING',
  'READY',
  'REJECTED',
  'SCAN_FAILED',
  'ARCHIVED'
);

-- CreateEnum
CREATE TYPE "AttachmentCategory" AS ENUM (
  'ACT_DOCUMENT',
  'ACT_SCAN',
  'DEFECT_PHOTO',
  'CLAIM_DOCUMENT',
  'THIRD_PARTY_DOCUMENT',
  'PROPOSAL_DOCUMENT',
  'OTHER'
);

ALTER TYPE "AuditSource" ADD VALUE IF NOT EXISTS 'SYSTEM';

ALTER TABLE "attachments" DROP CONSTRAINT "attachments_actId_fkey";
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_defectItemId_fkey";
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_uploadedById_fkey";
DROP TABLE "attachments";

CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "actId" UUID,
    "defectItemId" UUID,
    "proposalId" UUID,
    "originalFilename" TEXT NOT NULL,
    "safeDisplayName" TEXT NOT NULL,
    "objectKey" TEXT,
    "bucket" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "detectedMimeType" TEXT,
    "sha256" TEXT NOT NULL,
    "category" "AttachmentCategory" NOT NULL,
    "status" "AttachmentStatus" NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMPTZ(3),
    "scannedAt" TIMESTAMPTZ(3),
    "scanEngine" TEXT,
    "scanSignature" TEXT,
    "rejectionReason" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "archivedById" UUID,
    "archiveReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "failureCode" TEXT,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attachments_owner_xor" CHECK (
      (("actId" IS NOT NULL)::int + ("defectItemId" IS NOT NULL)::int + ("proposalId" IS NOT NULL)::int) = 1
    )
);

CREATE UNIQUE INDEX "attachments_objectKey_key" ON "attachments"("objectKey");
CREATE INDEX "attachments_actId_status_createdAt_idx" ON "attachments"("actId", "status", "createdAt");
CREATE INDEX "attachments_defectItemId_status_createdAt_idx" ON "attachments"("defectItemId", "status", "createdAt");
CREATE INDEX "attachments_proposalId_status_createdAt_idx" ON "attachments"("proposalId", "status", "createdAt");
CREATE INDEX "attachments_uploadedById_idx" ON "attachments"("uploadedById");
CREATE INDEX "attachments_sha256_idx" ON "attachments"("sha256");
CREATE INDEX "attachments_status_idx" ON "attachments"("status");
CREATE INDEX "attachments_createdAt_idx" ON "attachments"("createdAt");

CREATE UNIQUE INDEX "attachments_act_sha256_active" ON "attachments"("actId", "sha256")
  WHERE "actId" IS NOT NULL AND "status" IN ('PENDING_SCAN', 'SCANNING', 'READY', 'SCAN_FAILED');
CREATE UNIQUE INDEX "attachments_defect_sha256_active" ON "attachments"("defectItemId", "sha256")
  WHERE "defectItemId" IS NOT NULL AND "status" IN ('PENDING_SCAN', 'SCANNING', 'READY', 'SCAN_FAILED');
CREATE UNIQUE INDEX "attachments_proposal_sha256_active" ON "attachments"("proposalId", "sha256")
  WHERE "proposalId" IS NOT NULL AND "status" IN ('PENDING_SCAN', 'SCANNING', 'READY', 'SCAN_FAILED');

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_actId_fkey" FOREIGN KEY ("actId") REFERENCES "acts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_defectItemId_fkey" FOREIGN KEY ("defectItemId") REFERENCES "defect_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_settings" ADD COLUMN "maxAttachmentBytes" INTEGER NOT NULL DEFAULT 20971520;
ALTER TABLE "system_settings" ADD COLUMN "maxAttachmentsPerOwner" INTEGER NOT NULL DEFAULT 50;
