-- App INSERT ... RETURNING cannot see outbox/audit rows that SELECT policies hide
-- from SGR_MANAGER, RESPONSIBLE_ENGINEER and CONTRACTOR_ENGINEER. SECURITY DEFINER
-- writers insert as the table owner without granting journal SELECT to those roles.
-- Property-object catalog remains readable for VIEW_REFERENCE_DATA.

SET ROLE sgr_owner;

DROP POLICY IF EXISTS objects_select ON property_objects;
CREATE POLICY objects_select ON property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());

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
  IF NOT pg_has_role(session_user, 'sgr_app', 'member') THEN
    RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
  END IF;
  new_id := coalesce(p_id, gen_random_uuid());
  INSERT INTO public.outbox_events (id, type, payload, status, "updatedAt")
  VALUES (new_id, p_type, p_payload, 'PENDING', clock_timestamp());
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION sgr_insert_audit_log(
  uuid, text, text, text, text, text, text, jsonb, jsonb, text, public."AuditSource", timestamptz, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_insert_outbox_event(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sgr_insert_audit_log(
  uuid, text, text, text, text, text, text, jsonb, jsonb, text, public."AuditSource", timestamptz, text, text
) TO sgr_app, sgr_auth, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_insert_outbox_event(uuid, text, jsonb) TO sgr_app;

RESET ROLE;
