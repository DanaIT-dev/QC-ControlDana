-- The engineer who created an act can still read that act after unassignment.
-- Confirmation of a closure request is addressed to that engineer, so the
-- event must be readable by its recipient. This does not open the object
-- directory or other people's notifications.
SET ROLE sgr_owner;

CREATE POLICY ne_select_act_creator_recipient
  ON public.notification_events
  FOR SELECT
  TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND public.sgr_is_responsible()
    AND "actId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = "actId"
        AND a."createdById" = public.sgr_ctx_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM public.notification_recipients r
      WHERE r."notificationEventId" = id
        AND r."userId" = public.sgr_ctx_user_id()
        AND r."revokedAt" IS NULL
    )
  );

RESET ROLE;
