-- A new act may be saved before an official number is allocated.
-- Imported rows and every non-draft act still need a number or an import batch.

SET ROLE sgr_owner;

ALTER TABLE public.acts DROP CONSTRAINT acts_imported_number_presence;

ALTER TABLE public.acts ADD CONSTRAINT acts_imported_number_presence CHECK (
  "officialNumber" IS NOT NULL
  OR "importBatchId" IS NOT NULL
  OR status = 'NEW'
);
