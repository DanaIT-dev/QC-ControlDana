-- The previous policy compared the event id with the recipient row id.
-- Qualify the outer event so the author who is a recipient can read it.
SET ROLE sgr_owner;

DROP POLICY IF EXISTS ne_select_act_creator_recipient ON public.notification_events;

CREATE POLICY ne_select_act_creator_recipient
  ON public.notification_events
  FOR SELECT
  TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND public.sgr_is_responsible()
    AND notification_events."actId" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = notification_events."actId"
        AND a."createdById" = public.sgr_ctx_user_id()
    )
    AND EXISTS (
      SELECT 1
      FROM public.notification_recipients r
      WHERE r."notificationEventId" = notification_events.id
        AND r."userId" = public.sgr_ctx_user_id()
        AND r."revokedAt" IS NULL
    )
  );

RESET ROLE;
