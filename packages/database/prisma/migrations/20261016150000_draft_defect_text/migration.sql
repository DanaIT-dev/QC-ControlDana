-- A draft defect may omit location or description. Operational and imported
-- rows keep the previous requirement: both texts, or an import batch.

SET ROLE sgr_owner;

ALTER TABLE public.defect_items DROP CONSTRAINT IF EXISTS defect_items_imported_text_presence;

CREATE OR REPLACE FUNCTION public.sgr_guard_defect_text_presence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  act_status public."ActStatus";
BEGIN
  IF NEW."importBatchId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.status
  INTO act_status
  FROM public.acts a
  WHERE a.id = NEW."actId";

  IF act_status = 'NEW' THEN
    RETURN NEW;
  END IF;

  IF NEW.location IS NOT NULL
    AND btrim(NEW.location) <> ''
    AND NEW."claimDetails" IS NOT NULL
    AND btrim(NEW."claimDetails") <> '' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'defect text is required'
    USING ERRCODE = '23514', CONSTRAINT = 'defect_items_imported_text_presence';
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_guard_defect_text_presence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_guard_defect_text_presence() TO sgr_app, sgr_worker;

DROP TRIGGER IF EXISTS trg_sgr_guard_defect_text_presence ON public.defect_items;
CREATE TRIGGER trg_sgr_guard_defect_text_presence
  BEFORE INSERT OR UPDATE OF location, "claimDetails", "importBatchId", "actId"
  ON public.defect_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_defect_text_presence();

RESET ROLE;
