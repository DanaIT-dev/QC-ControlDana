-- The initial unique index on (defectItemId, slot) was created with CREATE UNIQUE INDEX.
-- A later migration tried to remove it with DROP CONSTRAINT, which does not drop an index,
-- so an archived proposal still blocked a new row for the same slot.
SET ROLE sgr_owner;

DROP INDEX IF EXISTS public."proposals_defectItemId_slot_key";
