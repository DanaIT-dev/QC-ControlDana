-- Unresolved imported engineers, search helper, RLS and batch rollback status.
SET ROLE sgr_owner;

CREATE TABLE IF NOT EXISTS public.imported_engineer_references (
  id UUID PRIMARY KEY,
  "defectItemId" UUID NOT NULL,
  "importBatchId" UUID NOT NULL,
  "sourceNameRaw" TEXT NOT NULL,
  "nameMatchKey" TEXT NOT NULL,
  "normalizedSurname" TEXT NOT NULL,
  "firstInitial" TEXT NOT NULL,
  "middleInitial" TEXT,
  "resolutionStatus" public."ImportedEngineerResolutionStatus" NOT NULL,
  "matchedUserId" UUID,
  "matchedAt" TIMESTAMPTZ(3),
  "matchedByUserId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT imported_engineer_refs_defect_fkey
    FOREIGN KEY ("defectItemId") REFERENCES public.defect_items(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT imported_engineer_refs_batch_fkey
    FOREIGN KEY ("importBatchId") REFERENCES public.import_batches(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT imported_engineer_refs_matched_user_fkey
    FOREIGN KEY ("matchedUserId") REFERENCES public.users(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT imported_engineer_refs_matched_by_fkey
    FOREIGN KEY ("matchedByUserId") REFERENCES public.users(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT imported_engineer_refs_status_match CHECK (
    (
      "resolutionStatus" = 'UNMATCHED'
      AND "matchedUserId" IS NULL
      AND "matchedAt" IS NULL
    )
    OR (
      "resolutionStatus" = 'RESOLVED'
      AND "matchedUserId" IS NOT NULL
    )
    OR "resolutionStatus" IN ('MATCHED', 'AMBIGUOUS')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS imported_engineer_refs_defect_key_unique
  ON public.imported_engineer_references ("defectItemId", "nameMatchKey");
CREATE INDEX IF NOT EXISTS imported_engineer_refs_batch_idx
  ON public.imported_engineer_references ("importBatchId");
CREATE INDEX IF NOT EXISTS imported_engineer_refs_status_idx
  ON public.imported_engineer_references ("resolutionStatus");
CREATE INDEX IF NOT EXISTS imported_engineer_refs_matched_user_idx
  ON public.imported_engineer_references ("matchedUserId");

CREATE OR REPLACE FUNCTION public.sgr_person_search_blob(full_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized text;
  parts text[];
  last_name text;
  first_name text;
  middle_name text;
  first_initial text;
  middle_initial text;
  short_name text;
BEGIN
  normalized := lower(replace(replace(btrim(regexp_replace(normalize(full_name, NFKC), '\s+', ' ', 'g')), 'ё', 'е'), 'Ё', 'е'));
  parts := regexp_split_to_array(normalized, ' ');
  last_name := COALESCE(parts[1], '');
  first_name := COALESCE(parts[2], '');
  middle_name := COALESCE(parts[3], '');
  first_initial := CASE WHEN first_name = '' THEN '' ELSE left(first_name, 1) END;
  middle_initial := CASE WHEN middle_name = '' THEN '' ELSE left(middle_name, 1) END;
  IF first_initial = '' THEN
    short_name := last_name;
  ELSIF middle_initial = '' THEN
    short_name := last_name || ' ' || first_initial || '.';
  ELSE
    short_name := last_name || ' ' || first_initial || '.' || middle_initial || '.';
  END IF;
  RETURN normalized || ' ' || short_name || ' ' || last_name || ' ' || first_name || ' ' || middle_name
    || ' ' || last_name || ' ' || first_initial;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_person_search_blob(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_person_search_blob(text) TO sgr_app, sgr_worker, sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_imported_engineer_after_user_removed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."matchedUserId" IS NULL AND OLD."matchedUserId" IS NOT NULL THEN
    NEW."resolutionStatus" := 'UNMATCHED';
    NEW."matchedAt" := NULL;
    NEW."matchedByUserId" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS imported_engineer_refs_user_removed ON public.imported_engineer_references;
CREATE TRIGGER imported_engineer_refs_user_removed
  BEFORE UPDATE ON public.imported_engineer_references
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_imported_engineer_after_user_removed();

ALTER TABLE public.imported_engineer_references OWNER TO sgr_owner;
ALTER TABLE public.imported_engineer_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.imported_engineer_references FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.imported_engineer_references FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;
GRANT SELECT, UPDATE ON TABLE public.imported_engineer_references TO sgr_app, sgr_worker;

DROP POLICY IF EXISTS imported_engineer_refs_select ON public.imported_engineer_references;
CREATE POLICY imported_engineer_refs_select ON public.imported_engineer_references
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR public.sgr_defect_assigned("defectItemId")
    OR public.sgr_app_visible_object((
      SELECT a."objectId"
      FROM public.defect_items d
      JOIN public.acts a ON a.id = d."actId"
      WHERE d.id = "defectItemId"
    ))
  );

DROP POLICY IF EXISTS imported_engineer_refs_update ON public.imported_engineer_references;
CREATE POLICY imported_engineer_refs_update ON public.imported_engineer_references
  FOR UPDATE TO sgr_app
  USING (public.sgr_ctx_verified() AND public.sgr_is_staff())
  WITH CHECK (public.sgr_ctx_verified() AND public.sgr_is_staff());

DROP POLICY IF EXISTS imported_engineer_refs_insert ON public.imported_engineer_references;
CREATE POLICY imported_engineer_refs_insert ON public.imported_engineer_references
  FOR INSERT TO sgr_app
  WITH CHECK (false);

DROP POLICY IF EXISTS imported_engineer_refs_delete ON public.imported_engineer_references;
CREATE POLICY imported_engineer_refs_delete ON public.imported_engineer_references
  FOR DELETE TO sgr_app
  USING (false);

RESET ROLE;
