-- Hide property-object catalog from SUPER_ADMIN without changing staff/contractor catalog access.
SET ROLE sgr_owner;

DROP POLICY IF EXISTS objects_select ON public.property_objects;
CREATE POLICY objects_select ON public.property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

RESET ROLE;
