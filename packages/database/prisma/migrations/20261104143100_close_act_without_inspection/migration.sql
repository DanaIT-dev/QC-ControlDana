-- Administrative close of an act without treating it as an accepted repair.
-- Historical rows stay NULL: no completion method is invented for them.
SET ROLE sgr_owner;

CREATE TYPE public."DefectClosureMethod" AS ENUM ('WITHOUT_INSPECTION');

ALTER TABLE public.acts
  ADD COLUMN "closureMethod" public."DefectClosureMethod",
  ADD COLUMN "closedWithoutInspectionAt" timestamptz(3),
  ADD COLUMN "closedWithoutInspectionByUserId" uuid,
  ADD COLUMN "closedWithoutInspectionByName" text,
  ADD COLUMN "closureReason" text;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_closed_without_inspection_by_fkey
  FOREIGN KEY ("closedWithoutInspectionByUserId") REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_without_inspection_fields CHECK (
    (
      "closureMethod" IS NULL
      AND "closedWithoutInspectionAt" IS NULL
      AND "closedWithoutInspectionByUserId" IS NULL
      AND "closedWithoutInspectionByName" IS NULL
      AND "closureReason" IS NULL
    )
    OR (
      "closureMethod" = 'WITHOUT_INSPECTION'
      AND status = 'COMPLETED'
      AND "closedWithoutInspectionAt" IS NOT NULL
      AND "closedWithoutInspectionByUserId" IS NOT NULL
      AND length(btrim("closedWithoutInspectionByName")) > 0
      AND length(btrim("closureReason")) > 0
    )
  );

CREATE INDEX acts_closed_without_inspection_by_idx
  ON public.acts ("closedWithoutInspectionByUserId");

ALTER TABLE public.defect_items
  ADD COLUMN "closureMethod" public."DefectClosureMethod";

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_without_inspection_not_accepted CHECK (
    "closureMethod" IS NULL
    OR (
      "closureMethod" = 'WITHOUT_INSPECTION'
      AND status = 'COMPLETED'
      AND "acceptedAt" IS NULL
      AND "acceptedByUserId" IS NULL
      AND "readyAt" IS NULL
    )
  );

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
  IF OLD.status IN ('ACCEPTED', 'REJECTED', 'TERMINATED') THEN
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
  IF NEW.status = 'TERMINATED' AND NEW."rejectionReason" IS NOT NULL THEN
    RAISE EXCEPTION 'terminated inspection is not a rejection' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS attempts_insert ON public.defect_inspection_attempts;
CREATE POLICY attempts_insert ON public.defect_inspection_attempts
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND status = 'PENDING'
    AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect("defectItemId")
      OR (public.sgr_is_responsible() AND public.sgr_defect_assigned("defectItemId"))
    )
  );

CREATE OR REPLACE FUNCTION public.sgr_satisfy_sla_clocks(p_defect_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  act_object uuid;
BEGIN
  IF NOT public.sgr_ctx_verified() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  SELECT a."objectId" INTO act_object
  FROM public.defect_items d
  JOIN public.acts a ON a.id = d."actId"
  WHERE d.id = p_defect_id;
  IF NOT (
    public.sgr_is_staff()
    OR (public.sgr_is_responsible() AND public.sgr_object_assigned(act_object))
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  UPDATE public.sla_clocks
  SET state = 'COMPLETED',
      "satisfiedAt" = coalesce("satisfiedAt", now()),
      version = version + 1,
      "updatedAt" = now()
  WHERE "defectItemId" = p_defect_id
    AND state IS DISTINCT FROM 'COMPLETED';
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_satisfy_sla_clocks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_satisfy_sla_clocks(uuid) TO sgr_app;
ALTER FUNCTION public.sgr_satisfy_sla_clocks(uuid) OWNER TO sgr_owner;

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
  "closureMethod" public."DefectClosureMethod",
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
    d."closureMethod",
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
