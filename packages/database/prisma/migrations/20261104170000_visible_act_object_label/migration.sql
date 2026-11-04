-- The act card already shows the object of an act the caller can read.
-- Object-table RLS still hides that row after the engineer is unassigned.
-- This function returns only the display fields for one already visible act.
-- It does not add the object to the directory, registry, attachments, or analytics.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_visible_act_object(act_id uuid)
RETURNS TABLE (
  name text,
  address text,
  "commissionedAt" timestamptz(3),
  "warrantyEndsAt" timestamptz(3)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.name, o.address, o."commissionedAt", o."warrantyEndsAt"
  FROM public.acts a
  JOIN public.property_objects o ON o.id = a."objectId"
  WHERE a.id = act_id
    AND (
      public.sgr_ctx_is_worker()
      OR public.sgr_is_super_admin()
      OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
      OR public.sgr_app_visible_object(a."objectId")
      OR public.sgr_contractor_can_see_act(a.id)
      OR (
        a.status = 'NEW'
        AND a."createdById" IS NOT NULL
        AND a."createdById" = public.sgr_ctx_user_id()
      )
      OR (
        public.sgr_is_responsible()
        AND a."createdById" IS NOT NULL
        AND a."createdById" = public.sgr_ctx_user_id()
      )
    );
$$;

REVOKE ALL ON FUNCTION public.sgr_visible_act_object(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_visible_act_object(uuid) TO sgr_app;

RESET ROLE;
