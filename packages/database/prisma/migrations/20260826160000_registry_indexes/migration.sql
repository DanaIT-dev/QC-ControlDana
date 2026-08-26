-- Registry list/filter indexes and stored effectiveDeadline for server-side sorting.
-- Do not edit previously applied init/auth migrations.

ALTER TABLE "defect_items"
ADD COLUMN "effectiveDeadline" TIMESTAMPTZ(3)
GENERATED ALWAYS AS (COALESCE("claimDeadline", "plannedDeadline")) STORED;

CREATE INDEX "defect_items_status_idx" ON "defect_items"("status");
CREATE INDEX "defect_items_plannedDeadline_idx" ON "defect_items"("plannedDeadline");
CREATE INDEX "defect_items_claimDeadline_idx" ON "defect_items"("claimDeadline");
CREATE INDEX "defect_items_readyAt_idx" ON "defect_items"("readyAt");
CREATE INDEX "defect_items_effectiveDeadline_idx" ON "defect_items"("effectiveDeadline");

CREATE INDEX "acts_objectId_idx" ON "acts"("objectId");
CREATE INDEX "acts_customerOrganizationId_idx" ON "acts"("customerOrganizationId");

CREATE INDEX "defect_item_engineers_userId_idx" ON "defect_item_engineers"("userId");
CREATE INDEX "defect_item_liable_organizations_organizationId_idx" ON "defect_item_liable_organizations"("organizationId");
