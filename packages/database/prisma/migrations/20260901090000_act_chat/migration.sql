-- Internal act discussion (staff only). Forward-only; does not alter prior checksums.
SET ROLE sgr_owner;

CREATE TABLE "act_chat_messages" (
  "id" UUID NOT NULL,
  "actId" UUID NOT NULL,
  "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "clientMessageId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "act_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "act_chat_messages_body_len" CHECK (char_length(btrim("body")) BETWEEN 1 AND 4000)
);

CREATE TABLE "act_chat_mentions" (
  "messageId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "act_chat_mentions_pkey" PRIMARY KEY ("messageId", "userId")
);

ALTER TABLE "act_chat_messages"
  ADD CONSTRAINT "act_chat_messages_actId_fkey"
  FOREIGN KEY ("actId") REFERENCES "acts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "act_chat_messages"
  ADD CONSTRAINT "act_chat_messages_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "act_chat_mentions"
  ADD CONSTRAINT "act_chat_mentions_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "act_chat_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "act_chat_mentions"
  ADD CONSTRAINT "act_chat_mentions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "act_chat_messages_authorId_clientMessageId_key"
  ON "act_chat_messages"("authorId", "clientMessageId");

CREATE INDEX "act_chat_messages_actId_createdAt_id_idx"
  ON "act_chat_messages"("actId", "createdAt", "id");

CREATE INDEX "act_chat_mentions_userId_idx"
  ON "act_chat_mentions"("userId");

CREATE OR REPLACE FUNCTION sgr_can_access_act_chat(p_act_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_act_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.sgr_ctx_verified() THEN
    RETURN false;
  END IF;
  IF public.sgr_ctx_role() IS NOT DISTINCT FROM 'CONTRACTOR_ENGINEER' THEN
    RETURN false;
  END IF;
  IF public.sgr_is_staff() THEN
    RETURN true;
  END IF;
  RETURN public.sgr_act_assigned(p_act_id);
END;
$$;

REVOKE ALL ON FUNCTION sgr_can_access_act_chat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sgr_can_access_act_chat(uuid) TO sgr_app, sgr_worker;

ALTER TABLE "act_chat_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "act_chat_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "act_chat_mentions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "act_chat_mentions" FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "act_chat_messages" FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;
REVOKE ALL ON TABLE "act_chat_mentions" FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;
GRANT SELECT, INSERT ON "act_chat_messages" TO sgr_app;
GRANT SELECT, INSERT ON "act_chat_mentions" TO sgr_app;

CREATE POLICY acm_select ON act_chat_messages FOR SELECT TO sgr_app
  USING (sgr_can_access_act_chat("actId"));

CREATE POLICY acm_insert ON act_chat_messages FOR INSERT TO sgr_app
  WITH CHECK (
    sgr_can_access_act_chat("actId")
    AND "authorId" = sgr_ctx_user_id()
  );

CREATE POLICY acm_update ON act_chat_messages FOR UPDATE TO sgr_app
  USING (false) WITH CHECK (false);

CREATE POLICY acm_delete ON act_chat_messages FOR DELETE TO sgr_app
  USING (false);

CREATE POLICY acn_select ON act_chat_mentions FOR SELECT TO sgr_app
  USING (
    EXISTS (
      SELECT 1 FROM act_chat_messages m
      WHERE m.id = "messageId" AND sgr_can_access_act_chat(m."actId")
    )
  );

CREATE POLICY acn_insert ON act_chat_mentions FOR INSERT TO sgr_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM act_chat_messages m
      WHERE m.id = "messageId" AND sgr_can_access_act_chat(m."actId")
    )
  );

CREATE POLICY acn_update ON act_chat_mentions FOR UPDATE TO sgr_app
  USING (false) WITH CHECK (false);

CREATE POLICY acn_delete ON act_chat_mentions FOR DELETE TO sgr_app
  USING (false);

DROP POLICY IF EXISTS ne_select ON notification_events;
CREATE POLICY ne_select ON notification_events FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker()
    OR (
      sgr_ctx_verified()
      AND type = 'ACT_CHAT_MENTION'
      AND sgr_can_access_act_chat("actId")
    )
    OR (
      sgr_ctx_verified()
      AND type IS DISTINCT FROM 'ACT_CHAT_MENTION'
      AND (
        sgr_is_staff()
        OR (
          ("actId" IS NOT NULL AND sgr_app_visible_object((SELECT a."objectId" FROM acts a WHERE a.id = "actId")))
          OR ("defectItemId" IS NOT NULL AND (
            sgr_ctx_role() = 'CONTRACTOR_ENGINEER' OR sgr_defect_assigned("defectItemId")
          ))
        )
      )
    )
  );

CREATE POLICY ne_insert_chat ON notification_events FOR INSERT TO sgr_app
  WITH CHECK (
    sgr_ctx_verified()
    AND sgr_ctx_role() IS DISTINCT FROM 'CONTRACTOR_ENGINEER'
    AND type = 'ACT_CHAT_MENTION'
    AND "actId" IS NOT NULL
    AND sgr_can_access_act_chat("actId")
  );

CREATE POLICY nr_insert_chat ON notification_recipients FOR INSERT TO sgr_app
  WITH CHECK (
    sgr_ctx_verified()
    AND sgr_ctx_role() IS DISTINCT FROM 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1 FROM notification_events e
      WHERE e.id = "notificationEventId"
        AND e.type = 'ACT_CHAT_MENTION'
        AND sgr_can_access_act_chat(e."actId")
    )
  );

RESET ROLE;
