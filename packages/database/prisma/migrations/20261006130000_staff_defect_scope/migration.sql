-- Staff can already read every defect. Reading them through RLS calls a
-- security-definer predicate on each row. This function checks staff once,
-- then returns the same rows. Non-staff callers are rejected.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_staff_defect_items()
RETURNS TABLE (
  id uuid,
  "actId" uuid,
  status public."DefectItemStatus",
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "readyAt" timestamptz,
  "effectiveDeadline" timestamptz,
  "defectTypeId" uuid,
  "workTypeId" uuid,
  location text,
  "submittedForInspectionAt" timestamptz,
  "acceptedAt" timestamptz,
  "rejectedAt" timestamptz,
  "importBatchId" uuid,
  "sourceSystem" text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.sgr_ctx_verified() OR NOT public.sgr_is_staff() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    d.id,
    d."actId",
    d.status,
    d."createdAt",
    d."updatedAt",
    d."readyAt",
    d."effectiveDeadline",
    d."defectTypeId",
    d."workTypeId",
    d.location,
    d."submittedForInspectionAt",
    d."acceptedAt",
    d."rejectedAt",
    d."importBatchId",
    d."sourceSystem"
  FROM public.defect_items d;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_staff_defect_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_staff_defect_items() TO sgr_app;
ALTER FUNCTION public.sgr_staff_defect_items() OWNER TO sgr_owner;

RESET ROLE;
