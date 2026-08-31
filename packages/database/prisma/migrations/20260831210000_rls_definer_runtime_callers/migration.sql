SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION sgr_insert_audit_log(
  p_actor_user_id uuid,
  p_actor_name text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_parent_entity_type text,
  p_parent_entity_id text,
  p_old_value jsonb,
  p_new_value jsonb,
  p_reason text,
  p_source public."AuditSource",
  p_occurred_at timestamptz,
  p_ip_address text,
  p_request_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT (
    pg_has_role(session_user, 'sgr_app', 'member')
    OR pg_has_role(session_user, 'sgr_auth', 'member')
    OR pg_has_role(session_user, 'sgr_worker', 'member')
    OR pg_has_role(session_user, 'sgr_owner', 'member')
  ) THEN
    RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
  END IF;
  INSERT INTO public.audit_logs (
    id,
    "actorUserId",
    "actorName",
    action,
    "entityType",
    "entityId",
    "parentEntityType",
    "parentEntityId",
    "oldValue",
    "newValue",
    reason,
    source,
    "occurredAt",
    "ipAddress",
    "requestId"
  ) VALUES (
    gen_random_uuid(),
    p_actor_user_id,
    p_actor_name,
    p_action,
    p_entity_type,
    p_entity_id,
    p_parent_entity_type,
    p_parent_entity_id,
    p_old_value,
    p_new_value,
    p_reason,
    p_source,
    coalesce(p_occurred_at, clock_timestamp()),
    p_ip_address,
    p_request_id
  )
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION sgr_insert_outbox_event(
  p_id uuid,
  p_type text,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT (
    pg_has_role(session_user, 'sgr_app', 'member')
    OR pg_has_role(session_user, 'sgr_worker', 'member')
    OR pg_has_role(session_user, 'sgr_owner', 'member')
  ) THEN
    RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
  END IF;
  new_id := coalesce(p_id, gen_random_uuid());
  INSERT INTO public.outbox_events (id, type, payload, status, "updatedAt")
  VALUES (new_id, p_type, p_payload, 'PENDING', clock_timestamp());
  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION sgr_insert_outbox_event(uuid, text, jsonb) TO sgr_worker;

DROP POLICY IF EXISTS nr_update_app ON notification_recipients;
CREATE POLICY nr_update_app ON notification_recipients FOR UPDATE TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      "userId" = sgr_ctx_user_id() OR sgr_is_staff()
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      "userId" = sgr_ctx_user_id() OR sgr_is_staff()
    )
  );

RESET ROLE;
