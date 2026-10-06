-- Join acts inside the staff read. The previous function still joined public.acts
-- under RLS once per defect, which repeated the staff predicate 100k times.
-- Staff can already see every act, so the join is the same set.
SET ROLE sgr_owner;

DROP FUNCTION public.sgr_staff_defect_items();

CREATE FUNCTION public.sgr_staff_defect_items()
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
  "sourceSystem" text,
  "actObjectId" uuid,
  "actCustomerOrganizationId" uuid,
  "actStatus" public."ActStatus"
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
    d."sourceSystem",
    a."objectId",
    a."customerOrganizationId",
    a.status
  FROM public.defect_items d
  JOIN public.acts a ON a.id = d."actId";
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_staff_defect_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_staff_defect_items() TO sgr_app;
ALTER FUNCTION public.sgr_staff_defect_items() OWNER TO sgr_owner;

RESET ROLE;
