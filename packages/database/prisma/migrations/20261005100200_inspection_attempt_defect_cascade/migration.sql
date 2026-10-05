-- Runtime roles still cannot delete attempt history. A privileged maintenance
-- delete of a defect removes its attempts so the row cannot dangle.
CREATE OR REPLACE FUNCTION public.sgr_guard_inspection_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user IN ('sgr_app', 'sgr_worker', 'sgr_auth') THEN
      RAISE EXCEPTION 'inspection attempt cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('ACCEPTED', 'REJECTED') THEN
    RAISE EXCEPTION 'inspection attempt is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW."defectItemId" IS DISTINCT FROM OLD."defectItemId"
     OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
     OR NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId"
     OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'inspection attempt identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'PENDING' AND (
    NEW."reviewedAt" IS NOT NULL OR NEW."reviewedByUserId" IS NOT NULL OR NEW."rejectionReason" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pending inspection attempt cannot be reviewed in place' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.defect_inspection_attempts
  DROP CONSTRAINT IF EXISTS defect_inspection_attempts_defectItemId_fkey;

ALTER TABLE public.defect_inspection_attempts
  ADD CONSTRAINT defect_inspection_attempts_defectItemId_fkey
  FOREIGN KEY ("defectItemId") REFERENCES public.defect_items(id)
  ON DELETE CASCADE ON UPDATE CASCADE;
