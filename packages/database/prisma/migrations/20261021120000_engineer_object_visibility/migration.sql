-- Engineers see defects of assigned objects. Organization membership no longer grants visibility.

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_defect(defect_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1
      FROM public.defect_items d
      JOIN public.acts a ON a.id = d."actId"
      WHERE d.id = defect_id
        AND a.status <> 'CANCELLED'
        AND public.sgr_object_assigned(a."objectId")
    )
$$;

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_act(act_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = act_id
        AND a.status <> 'CANCELLED'
        AND public.sgr_object_assigned(a."objectId")
    )
$$;

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_object(oid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND public.sgr_object_assigned(oid)
$$;
