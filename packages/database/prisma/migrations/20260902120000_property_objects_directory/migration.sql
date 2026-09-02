-- Property objects directory fields and nullable address for Excel import.
-- Does not rewrite RLS policies on property_objects or other tables.
SET ROLE sgr_owner;

ALTER TABLE public.property_objects
  ALTER COLUMN address DROP NOT NULL;

ALTER TABLE public.property_objects
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sourceResponsibleEngineerName" TEXT,
  ADD COLUMN "sourceSystem" TEXT,
  ADD COLUMN "sourceRow" INTEGER,
  ADD COLUMN "sourceImportKey" TEXT;

CREATE INDEX "property_objects_sort_order_name_idx"
  ON public.property_objects ("sortOrder", name);

CREATE UNIQUE INDEX "property_objects_source_import_key_unique"
  ON public.property_objects ("sourceSystem", "sourceImportKey");

ALTER TABLE public.property_objects
  ADD CONSTRAINT property_objects_source_identity_chk CHECK (
    (
      "sourceSystem" IS NULL
      AND "sourceImportKey" IS NULL
      AND "sourceRow" IS NULL
    )
    OR (
      "sourceSystem" IS NOT NULL
      AND "sourceImportKey" IS NOT NULL
      AND "sourceRow" IS NOT NULL
    )
  );

RESET ROLE;
