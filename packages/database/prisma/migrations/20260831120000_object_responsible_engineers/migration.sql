-- Unique Object ↔ Responsible Engineer pairs, assignedBy audit, backfill from DefectItem.

DELETE FROM "property_object_engineers" AS a
USING "property_object_engineers" AS b
WHERE a."propertyObjectId" = b."propertyObjectId"
  AND a."userId" = b."userId"
  AND a.id <> b.id
  AND (
    (a."unassignedAt" IS NOT NULL AND b."unassignedAt" IS NULL)
    OR (
      (a."unassignedAt" IS NULL) IS NOT DISTINCT FROM (b."unassignedAt" IS NULL)
      AND (
        a."assignedAt" < b."assignedAt"
        OR (a."assignedAt" = b."assignedAt" AND a.id::text < b.id::text)
      )
    )
  );

ALTER TABLE "property_object_engineers" ADD COLUMN "assignedByUserId" UUID;

ALTER TABLE "property_object_engineers"
  ADD CONSTRAINT "property_object_engineers_assignedByUserId_fkey"
  FOREIGN KEY ("assignedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "property_object_engineers_propertyObjectId_idx";
DROP INDEX IF EXISTS "property_object_engineers_userId_idx";

CREATE UNIQUE INDEX "property_object_engineers_propertyObjectId_userId_key"
  ON "property_object_engineers"("propertyObjectId", "userId");

CREATE INDEX "property_object_engineers_userId_propertyObjectId_idx"
  ON "property_object_engineers"("userId", "propertyObjectId");

INSERT INTO "property_object_engineers" (id, "propertyObjectId", "userId", "assignedAt")
SELECT gen_random_uuid(), src."objectId", src."userId", src."assignedAt"
FROM (
  SELECT a."objectId" AS "objectId", die."userId" AS "userId", MIN(di."createdAt") AS "assignedAt"
  FROM "defect_item_engineers" die
  INNER JOIN "defect_items" di ON di.id = die."defectItemId"
  INNER JOIN "acts" a ON a.id = di."actId"
  INNER JOIN "users" u ON u.id = die."userId" AND u.role = 'RESPONSIBLE_ENGINEER'
  GROUP BY a."objectId", die."userId"
) src
WHERE NOT EXISTS (
  SELECT 1
  FROM "property_object_engineers" poe
  WHERE poe."propertyObjectId" = src."objectId"
    AND poe."userId" = src."userId"
);
