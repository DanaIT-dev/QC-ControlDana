-- Saving an existing defect may clear location and description.
-- Inserting a defect into an act that is already past the draft still requires both texts,
-- except imported rows.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_guard_defect_text_presence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  act_status public."ActStatus";
BEGIN
  IF TG_OP = 'UPDATE' OR NEW."importBatchId" IS NOT NULL THEN
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

RESET ROLE;
