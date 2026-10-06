-- Staff, super-admin, and worker visibility does not depend on the act row.
-- Evaluating those checks before the correlated act lookup keeps the same
-- rows visible and avoids repeating that lookup for every defect.
SET ROLE sgr_owner;

DROP POLICY IF EXISTS acts_select ON public.acts;
CREATE POLICY acts_select ON public.acts FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
    OR public.sgr_app_visible_object("objectId")
    OR public.sgr_contractor_can_see_act(id)
  );

DROP POLICY IF EXISTS defects_select ON public.defect_items;
CREATE POLICY defects_select ON public.defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
    OR public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
    OR public.sgr_contractor_can_see_defect(id)
  );
