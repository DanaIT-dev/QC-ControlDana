-- A user must be able to read their own object assignment. Contractor and
-- engineer registry filters join this table, and the previous policy hid those
-- rows from the assigned user.

DROP POLICY IF EXISTS poe_select ON public.property_object_engineers;
CREATE POLICY poe_select ON public.property_object_engineers FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object("propertyObjectId")
    OR "userId" = public.sgr_ctx_user_id()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );
