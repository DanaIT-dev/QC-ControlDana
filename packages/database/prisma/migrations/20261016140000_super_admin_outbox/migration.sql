-- SUPER_ADMIN has the same business capabilities as staff. Outbox writes must
-- not fail after a successful mutation. Pending and unassigned roles stay denied.

SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_insert_outbox_event(
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
  IF pg_has_role(session_user, 'sgr_app', 'member')
    AND NOT pg_has_role(session_user, 'sgr_worker', 'member')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'member')
    AND NOT public.sgr_is_business_user() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  new_id := coalesce(p_id, gen_random_uuid());
  INSERT INTO public.outbox_events (id, type, payload, status, "updatedAt")
  VALUES (new_id, p_type, p_payload, 'PENDING', clock_timestamp());
  RETURN new_id;
END;
$$;

RESET ROLE;
