-- Grant/revoke must count and lock every ADMIN row, independent of caller RLS.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_grant_admin(target_id uuid, expected_version integer)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  previous_role public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  target public.users%ROWTYPE;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF target_id IS NULL OR target_id = public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target FROM public.users WHERE users.id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF expected_version IS NOT NULL AND target.version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  IF target.role = 'ADMIN' AND target.status = 'ACTIVE' THEN
    RETURN QUERY SELECT
      target.id,
      target."fullName",
      target.email,
      target.role,
      target."roleBeforeAdmin",
      target.status,
      target."archivedAt",
      target.version;
    RETURN;
  END IF;

  IF target.status IS DISTINCT FROM 'ACTIVE'
    OR target."archivedAt" IS NOT NULL
    OR target.role NOT IN ('SGR_MANAGER'::public."UserRole", 'RESPONSIBLE_ENGINEER'::public."UserRole") THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('sgr.admin_grant', '1', true);
  UPDATE public.users
  SET
    role = 'ADMIN',
    "roleBeforeAdmin" = target.role,
    "sessionVersion" = target."sessionVersion" + 1,
    version = target.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = target_id;

  RETURN QUERY
  SELECT u.id, u."fullName", u.email, u.role, u."roleBeforeAdmin", u.status, u."archivedAt", u.version
  FROM public.users u
  WHERE u.id = target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_revoke_admin(target_id uuid, expected_version integer)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  previous_role public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  target public.users%ROWTYPE;
  restored public."UserRole";
  active_count integer;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF target_id IS NULL OR target_id = public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  PERFORM u.id
  FROM public.users u
  WHERE u.role = 'ADMIN' AND u.status = 'ACTIVE'
  FOR UPDATE;

  SELECT * INTO target FROM public.users WHERE users.id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF expected_version IS NOT NULL AND target.version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  IF target.role IS DISTINCT FROM 'ADMIN' THEN
    RETURN QUERY SELECT
      target.id,
      target."fullName",
      target.email,
      target.role,
      target."roleBeforeAdmin",
      target.status,
      target."archivedAt",
      target.version;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_count
  FROM public.users
  WHERE role = 'ADMIN' AND status = 'ACTIVE';
  IF active_count <= 1 THEN
    RAISE EXCEPTION 'Нельзя снять права последнего администратора' USING ERRCODE = 'P0001';
  END IF;

  restored := CASE
    WHEN target."roleBeforeAdmin" = 'SGR_MANAGER'::public."UserRole"
      OR target."roleBeforeAdmin" = 'RESPONSIBLE_ENGINEER'::public."UserRole"
      THEN target."roleBeforeAdmin"
    ELSE 'SGR_MANAGER'::public."UserRole"
  END;

  PERFORM set_config('sgr.admin_grant', '1', true);
  UPDATE public.users
  SET
    role = restored,
    "roleBeforeAdmin" = NULL,
    "sessionVersion" = target."sessionVersion" + 1,
    version = target.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = target_id;

  RETURN QUERY
  SELECT u.id, u."fullName", u.email, u.role, u."roleBeforeAdmin", u.status, u."archivedAt", u.version
  FROM public.users u
  WHERE u.id = target_id;
END;
$$;

RESET ROLE;
