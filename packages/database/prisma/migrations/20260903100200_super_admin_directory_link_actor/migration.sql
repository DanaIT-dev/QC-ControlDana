-- SUPER_ADMIN profile FIO changes must be able to run engineer-link reconciliation
-- without gaining other business-data write capabilities.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_directory_link_actor(
  p_actor_user_id uuid,
  p_actor_name text,
  OUT actor_id uuid,
  OUT actor_name text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime boolean;
  ctx_name text;
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');

  IF runtime THEN
    IF NOT public.sgr_ctx_verified() OR NOT (
      public.sgr_is_operations_admin() OR public.sgr_is_super_admin()
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
    SELECT u."fullName" INTO ctx_name FROM public.users u WHERE u.id = actor_id;
    IF ctx_name IS NULL THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_name := ctx_name;
    RETURN;
  END IF;

  IF NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  actor_id := p_actor_user_id;
  actor_name := coalesce(nullif(p_actor_name, ''), 'system');
END;
$$;

RESET ROLE;
