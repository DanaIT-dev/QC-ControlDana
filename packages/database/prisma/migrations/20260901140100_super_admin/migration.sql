-- Isolated SUPER_ADMIN role, previous-role preservation, last-admin lock,
-- safe user directory, and sgr_app/sgr_worker SELECT without passwordHash.
SET ROLE sgr_owner;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS "roleBeforeAdmin" public."UserRole";

UPDATE public.users
SET "roleBeforeAdmin" = 'SGR_MANAGER'
WHERE role = 'ADMIN'
  AND "roleBeforeAdmin" IS NULL;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_before_admin_chk;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_before_admin_chk CHECK (
    (
      role = 'ADMIN'
      AND "roleBeforeAdmin" IN ('SGR_MANAGER', 'RESPONSIBLE_ENGINEER')
    )
    OR (
      role <> 'ADMIN'
      AND "roleBeforeAdmin" IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS users_one_active_super_admin
  ON public.users ((1))
  WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE';

CREATE OR REPLACE FUNCTION public.sgr_is_business_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IS DISTINCT FROM 'SUPER_ADMIN'
$$;

CREATE OR REPLACE FUNCTION public.sgr_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() = 'SUPER_ADMIN'
$$;

REVOKE ALL ON FUNCTION public.sgr_is_business_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_is_business_user() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_is_super_admin() TO sgr_app, sgr_worker;

DROP POLICY IF EXISTS users_app_select ON public.users;
CREATE POLICY users_app_select ON public.users FOR SELECT TO sgr_app
  USING (public.sgr_is_business_user());

DROP POLICY IF EXISTS org_select ON public.organizations;
CREATE POLICY org_select ON public.organizations FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS org_roles_select ON public.organization_role_assignments;
CREATE POLICY org_roles_select ON public.organization_role_assignments FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS org_wt_select ON public.organization_work_types;
CREATE POLICY org_wt_select ON public.organization_work_types FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS work_types_select ON public.work_types;
CREATE POLICY work_types_select ON public.work_types FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS defect_types_select ON public.defect_types;
CREATE POLICY defect_types_select ON public.defect_types FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS settings_select ON public.system_settings;
CREATE POLICY settings_select ON public.system_settings FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_business_user() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS sla_write_app ON public.sla_clocks;
CREATE POLICY sla_write_app ON public.sla_clocks FOR ALL TO sgr_app
  USING (public.sgr_is_business_user()) WITH CHECK (public.sgr_is_business_user());

DROP POLICY IF EXISTS outbox_insert ON public.outbox_events;
CREATE POLICY outbox_insert ON public.outbox_events FOR INSERT TO sgr_app
  WITH CHECK (public.sgr_is_business_user());

CREATE OR REPLACE FUNCTION public.sgr_guard_user_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'sgr_app' AND OLD.role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.role = 'ADMIN' AND NEW."roleBeforeAdmin" IS NULL THEN
    NEW."roleBeforeAdmin" := 'SGR_MANAGER';
  END IF;
  IF NEW.role IS DISTINCT FROM 'ADMIN' THEN
    NEW."roleBeforeAdmin" := NULL;
  END IF;

  IF current_user <> 'sgr_app' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF current_setting('sgr.admin_grant', true) IS DISTINCT FROM '1' THEN
    IF OLD.role = 'ADMIN' AND (
      NEW.role IS DISTINCT FROM OLD.role
      OR NEW.status IS DISTINCT FROM OLD.status
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role = 'ADMIN' AND OLD.role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sgr_guard_user_mutation ON public.users;
CREATE TRIGGER trg_sgr_guard_user_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_user_mutation();

REVOKE ALL ON FUNCTION public.sgr_guard_user_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.sgr_super_admin_directory(p_kind text, p_search text)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  needle text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    u.id,
    u."fullName",
    u.email,
    u.role,
    u.status,
    u."archivedAt",
    u.version
  FROM public.users u
  WHERE
    (
      (p_kind = 'admins' AND u.role = 'ADMIN' AND u.status = 'ACTIVE')
      OR (
        p_kind = 'eligible'
        AND u.status = 'ACTIVE'
        AND u."archivedAt" IS NULL
        AND u.role IN ('SGR_MANAGER', 'RESPONSIBLE_ENGINEER')
      )
    )
    AND (
      needle IS NULL
      OR u."fullName" ILIKE '%' || needle || '%'
      OR u.email ILIKE '%' || needle || '%'
    )
  ORDER BY u."fullName" ASC, u.id ASC
  LIMIT 100;
END;
$$;

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
    OR target.role NOT IN ('SGR_MANAGER', 'RESPONSIBLE_ENGINEER') THEN
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

  PERFORM 1 FROM public.users WHERE role = 'ADMIN' AND status = 'ACTIVE' FOR UPDATE;

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
    WHEN target."roleBeforeAdmin" IN ('SGR_MANAGER', 'RESPONSIBLE_ENGINEER') THEN target."roleBeforeAdmin"
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

REVOKE ALL ON FUNCTION public.sgr_super_admin_directory(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_grant_admin(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_revoke_admin(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_super_admin_directory(text, text) TO sgr_app;
GRANT EXECUTE ON FUNCTION public.sgr_grant_admin(uuid, integer) TO sgr_app;
GRANT EXECUTE ON FUNCTION public.sgr_revoke_admin(uuid, integer) TO sgr_app;

REVOKE SELECT ON public.users FROM sgr_app;
REVOKE SELECT ON public.users FROM sgr_worker;
GRANT SELECT (
  id,
  "fullName",
  email,
  phone,
  "passwordChangedAt",
  "mustChangePassword",
  "sessionVersion",
  "lastLoginAt",
  role,
  "roleBeforeAdmin",
  status,
  version,
  "createdAt",
  "updatedAt",
  "archivedAt"
) ON public.users TO sgr_app;
GRANT SELECT (
  id,
  "fullName",
  email,
  phone,
  "passwordChangedAt",
  "mustChangePassword",
  "sessionVersion",
  "lastLoginAt",
  role,
  "roleBeforeAdmin",
  status,
  version,
  "createdAt",
  "updatedAt",
  "archivedAt"
) ON public.users TO sgr_worker;
GRANT SELECT ("passwordHash") ON public.users TO sgr_auth;

CREATE OR REPLACE FUNCTION public.sgr_can_access_act_chat(p_act_id uuid)
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
  IF public.sgr_is_super_admin() THEN
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

DROP POLICY IF EXISTS nr_select ON public.notification_recipients;
CREATE POLICY nr_select ON public.notification_recipients FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR (public.sgr_is_business_user() AND "userId" = public.sgr_ctx_user_id())
    OR public.sgr_is_staff()
  );

RESET ROLE;
