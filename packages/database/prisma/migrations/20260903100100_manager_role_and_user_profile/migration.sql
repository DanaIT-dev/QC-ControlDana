-- MANAGER operational access, role hierarchy, and protected user profile updates.
SET ROLE sgr_owner;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_before_admin_chk;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_before_admin_chk CHECK (
    role <> 'UNASSIGNED'::public."UserRole"
    AND (
      (
        role = 'ADMIN'::public."UserRole"
        AND "roleBeforeAdmin" IN (
          'MANAGER'::public."UserRole",
          'SGR_MANAGER'::public."UserRole",
          'RESPONSIBLE_ENGINEER'::public."UserRole",
          'CONTRACTOR_ENGINEER'::public."UserRole",
          'UNASSIGNED'::public."UserRole"
        )
      )
      OR (
        role <> 'ADMIN'::public."UserRole"
        AND "roleBeforeAdmin" IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION public.sgr_role_rank(p_role public."UserRole")
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_role
    WHEN 'SUPER_ADMIN'::public."UserRole" THEN 100
    WHEN 'ADMIN'::public."UserRole" THEN 80
    WHEN 'MANAGER'::public."UserRole" THEN 60
    WHEN 'SGR_MANAGER'::public."UserRole" THEN 40
    WHEN 'RESPONSIBLE_ENGINEER'::public."UserRole" THEN 20
    WHEN 'CONTRACTOR_ENGINEER'::public."UserRole" THEN 10
    WHEN 'PENDING_ROLE'::public."UserRole" THEN 5
    WHEN 'UNASSIGNED'::public."UserRole" THEN 0
    ELSE 0
  END
$$;

REVOKE ALL ON FUNCTION public.sgr_role_rank(public."UserRole") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_role_rank(public."UserRole") TO sgr_app, sgr_worker, sgr_auth;

CREATE OR REPLACE FUNCTION public.sgr_is_operations_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_role() IN ('ADMIN', 'MANAGER')
$$;

REVOKE ALL ON FUNCTION public.sgr_is_operations_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_is_operations_admin() TO sgr_app, sgr_worker;

CREATE OR REPLACE FUNCTION public.sgr_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_is_operations_admin()
$$;

CREATE OR REPLACE FUNCTION public.sgr_app_create_act()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() IN (
    'ADMIN', 'MANAGER', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER'
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SGR_MANAGER')
$$;

CREATE OR REPLACE FUNCTION public.sgr_guard_user_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_role public."UserRole";
  actor_id uuid;
  profile_update boolean := current_setting('sgr.profile_update', true) IS NOT DISTINCT FROM '1';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'sgr_app', 'member')
      AND NOT pg_has_role(current_user, 'sgr_owner', 'member')
      AND OLD.role IN ('ADMIN', 'SUPER_ADMIN', 'MANAGER') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.role = 'UNASSIGNED'::public."UserRole" THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF NEW.role = 'ADMIN'::public."UserRole" AND NEW."roleBeforeAdmin" IS NULL THEN
    NEW."roleBeforeAdmin" := 'UNASSIGNED'::public."UserRole";
  END IF;
  IF NEW.role IS DISTINCT FROM 'ADMIN'::public."UserRole" THEN
    NEW."roleBeforeAdmin" := NULL;
  END IF;

  IF pg_has_role(current_user, 'sgr_owner', 'member') THEN
    RETURN NEW;
  END IF;

  IF NOT pg_has_role(current_user, 'sgr_app', 'member') THEN
    RETURN NEW;
  END IF;

  actor_role := public.sgr_ctx_role()::public."UserRole";
  actor_id := public.sgr_ctx_user_id();

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('ADMIN', 'SUPER_ADMIN', 'UNASSIGNED', 'PENDING_ROLE') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF public.sgr_role_rank(NEW.role) >= public.sgr_role_rank(actor_role) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF NOT profile_update AND (
    NEW."fullName" IS DISTINCT FROM OLD."fullName"
    OR NEW.email IS DISTINCT FROM OLD.email
  ) THEN
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
    IF NEW.role = 'PENDING_ROLE' AND OLD.role IS DISTINCT FROM 'PENDING_ROLE' THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF actor_id IS NOT DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
      IF public.sgr_role_rank(OLD.role) >= public.sgr_role_rank(actor_role)
        OR public.sgr_role_rank(NEW.role) >= public.sgr_role_rank(actor_role) THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF actor_id IS NOT DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
      IF public.sgr_role_rank(OLD.role) >= public.sgr_role_rank(actor_role) THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS users_app_write ON public.users;
CREATE POLICY users_app_write ON public.users FOR ALL TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (public.sgr_is_operations_admin() OR public.sgr_is_super_admin())
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (public.sgr_is_operations_admin() OR public.sgr_is_super_admin())
  );

CREATE OR REPLACE FUNCTION public.sgr_upsert_user_credentials(
  p_user_id uuid,
  p_password_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(session_user, 'sgr_auth', 'member') THEN
    NULL;
  ELSIF pg_has_role(session_user, 'sgr_app', 'member')
    AND public.sgr_is_operations_admin()
    AND public.sgr_ctx_verified() THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.role <> 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.user_credentials (
    "userId",
    "passwordHash",
    "passwordChangedAt",
    "createdAt",
    "updatedAt"
  ) VALUES (
    p_user_id,
    p_password_hash,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  )
  ON CONFLICT ("userId") DO UPDATE SET
    "passwordHash" = EXCLUDED."passwordHash",
    "passwordChangedAt" = EXCLUDED."passwordChangedAt",
    "updatedAt" = clock_timestamp();
END;
$$;

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
    IF NOT public.sgr_ctx_verified() OR NOT public.sgr_is_operations_admin() THEN
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

CREATE OR REPLACE FUNCTION public.sgr_migration_health()
RETURNS TABLE (
  status text,
  pending integer,
  failed integer,
  last_finished_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  pending_count integer := 0;
  failed_count integer := 0;
  last_finished timestamptz;
BEGIN
  IF NOT public.sgr_ctx_verified() OR NOT (
    public.sgr_is_operations_admin() OR public.sgr_is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF to_regclass('public._prisma_migrations') IS NULL THEN
    status := 'down';
    pending := 0;
    failed := 0;
    last_finished_at := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE finished_at IS NULL),
    count(*) FILTER (WHERE rolled_back_at IS NOT NULL),
    max(finished_at)
  INTO pending_count, failed_count, last_finished
  FROM public._prisma_migrations;

  pending := pending_count;
  failed := failed_count;
  last_finished_at := last_finished;
  IF pending_count > 0 OR failed_count > 0 THEN
    status := 'degraded';
  ELSE
    status := 'ok';
  END IF;
  RETURN NEXT;
END;
$$;

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
        AND u.role IN (
          'MANAGER',
          'SGR_MANAGER',
          'RESPONSIBLE_ENGINEER',
          'CONTRACTOR_ENGINEER',
          'PENDING_ROLE'
        )
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
SET row_security = off
AS $$
DECLARE
  target public.users%ROWTYPE;
  stored_previous public."UserRole";
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
    OR target.role NOT IN (
      'MANAGER',
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
      'PENDING_ROLE'
    ) THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  stored_previous := CASE
    WHEN target.role = 'PENDING_ROLE'::public."UserRole" THEN 'UNASSIGNED'::public."UserRole"
    ELSE target.role
  END;

  PERFORM set_config('sgr.admin_grant', '1', true);
  UPDATE public.users
  SET
    role = 'ADMIN',
    "roleBeforeAdmin" = stored_previous,
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

  PERFORM admin_users.id
  FROM public.users AS admin_users
  WHERE admin_users.role = 'ADMIN' AND admin_users.status = 'ACTIVE'
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
  FROM public.users AS admin_users
  WHERE admin_users.role = 'ADMIN' AND admin_users.status = 'ACTIVE';
  IF active_count <= 1 THEN
    RAISE EXCEPTION 'Нельзя снять права последнего администратора' USING ERRCODE = 'P0001';
  END IF;

  restored := CASE
    WHEN target."roleBeforeAdmin" IN (
      'MANAGER'::public."UserRole",
      'SGR_MANAGER'::public."UserRole",
      'RESPONSIBLE_ENGINEER'::public."UserRole",
      'CONTRACTOR_ENGINEER'::public."UserRole"
    ) THEN target."roleBeforeAdmin"
    ELSE 'PENDING_ROLE'::public."UserRole"
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

CREATE OR REPLACE FUNCTION public.sgr_update_user_profile(
  p_target_id uuid,
  p_last_name text,
  p_first_name text,
  p_middle_name text,
  p_email text,
  p_expected_version integer,
  p_actor_user_id uuid,
  p_actor_name text,
  p_request_id text
)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  role public."UserRole",
  status public."UserStatus",
  version integer,
  session_version integer,
  email_changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  runtime boolean;
  actor_id uuid;
  actor_role public."UserRole";
  actor_name text;
  target public.users%ROWTYPE;
  next_last text;
  next_first text;
  next_middle text;
  next_full text;
  next_email text;
  changed_email boolean := false;
  changed_name boolean := false;
  now_ts timestamptz := clock_timestamp();
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');

  IF runtime THEN
    IF NOT public.sgr_ctx_verified() THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
    IF p_actor_user_id IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := p_actor_user_id;
  END IF;

  SELECT u.role, u."fullName" INTO actor_role, actor_name
  FROM public.users u WHERE u.id = actor_id;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  actor_name := coalesce(nullif(p_actor_name, ''), actor_name, 'system');

  IF actor_role NOT IN (
    'SUPER_ADMIN'::public."UserRole",
    'ADMIN'::public."UserRole",
    'MANAGER'::public."UserRole"
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO target FROM public.users WHERE users.id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  IF actor_id IS DISTINCT FROM target.id
    AND public.sgr_role_rank(target.role) >= public.sgr_role_rank(actor_role) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF p_expected_version IS NULL OR target.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  next_last := btrim(regexp_replace(normalize(coalesce(p_last_name, ''), NFKC), '\s+', ' ', 'g'));
  next_first := btrim(regexp_replace(normalize(coalesce(p_first_name, ''), NFKC), '\s+', ' ', 'g'));
  next_middle := nullif(
    btrim(regexp_replace(normalize(coalesce(p_middle_name, ''), NFKC), '\s+', ' ', 'g')),
    ''
  );
  next_email := lower(btrim(coalesce(p_email, '')));

  IF next_last = '' OR next_first = '' THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;
  IF next_last ~ '[[:cntrl:]]' OR next_first ~ '[[:cntrl:]]'
    OR coalesce(next_middle, '') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Недопустимые символы' USING ERRCODE = '22023';
  END IF;
  IF position(' ' in next_last) > 0 OR position(' ' in next_first) > 0
    OR position(' ' in coalesce(next_middle, '')) > 0 THEN
    RAISE EXCEPTION 'Укажите одно слово без пробелов' USING ERRCODE = '22023';
  END IF;

  next_full := next_last || ' ' || next_first || coalesce(' ' || next_middle, '');
  IF char_length(next_full) > 200 THEN
    RAISE EXCEPTION 'Некорректное ФИО' USING ERRCODE = '22023';
  END IF;
  IF next_email = '' OR char_length(next_email) > 254 OR position('@' in next_email) = 0 THEN
    RAISE EXCEPTION 'Некорректный адрес электронной почты' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id <> target.id AND lower(u.email) = next_email
  ) THEN
    RAISE EXCEPTION 'Пользователь с такой почтой уже существует' USING ERRCODE = '23505';
  END IF;

  changed_email := next_email IS DISTINCT FROM target.email;
  changed_name := next_full IS DISTINCT FROM target."fullName";

  PERFORM set_config('sgr.profile_update', '1', true);
  UPDATE public.users
  SET
    "fullName" = next_full,
    email = next_email,
    "sessionVersion" = CASE WHEN changed_email THEN target."sessionVersion" + 1 ELSE target."sessionVersion" END,
    version = target.version + 1,
    "updatedAt" = now_ts
  WHERE users.id = target.id
    AND users.version = p_expected_version
    AND users.role = target.role
    AND users.status = target.status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  IF changed_name OR changed_email THEN
    PERFORM public.sgr_insert_audit_log(
      actor_id,
      actor_name,
      'USER_PROFILE_UPDATED',
      'USER',
      target.id::text,
      NULL,
      NULL,
      jsonb_build_object(
        'targetUserId', target.id,
        'actorId', actor_id,
        'fullName', target."fullName",
        'email', target.email,
        'changedFields', ARRAY(
          SELECT field FROM unnest(ARRAY[
            CASE WHEN changed_name THEN 'fullName' END,
            CASE WHEN changed_email THEN 'email' END
          ]) AS field
          WHERE field IS NOT NULL
        )
      ),
      jsonb_build_object(
        'targetUserId', target.id,
        'actorId', actor_id,
        'fullName', next_full,
        'email', next_email,
        'changedFields', ARRAY(
          SELECT field FROM unnest(ARRAY[
            CASE WHEN changed_name THEN 'fullName' END,
            CASE WHEN changed_email THEN 'email' END
          ]) AS field
          WHERE field IS NOT NULL
        )
      ),
      NULL,
      'WEB'::public."AuditSource",
      now_ts,
      NULL,
      p_request_id
    );
  END IF;

  IF changed_email THEN
    PERFORM public.sgr_insert_audit_log(
      actor_id,
      actor_name,
      'USER_EMAIL_CHANGED',
      'USER',
      target.id::text,
      NULL,
      NULL,
      jsonb_build_object('targetUserId', target.id, 'actorId', actor_id, 'email', target.email),
      jsonb_build_object('targetUserId', target.id, 'actorId', actor_id, 'email', next_email),
      NULL,
      'WEB'::public."AuditSource",
      now_ts,
      NULL,
      p_request_id
    );
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u."fullName",
    u.email,
    u.role,
    u.status,
    u.version,
    u."sessionVersion",
    changed_email
  FROM public.users u
  WHERE u.id = target.id;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_update_user_profile(
  uuid, text, text, text, text, integer, uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_update_user_profile(
  uuid, text, text, text, text, integer, uuid, text, text
) TO sgr_app;

DROP POLICY IF EXISTS outbox_select_admin ON public.outbox_events;
CREATE POLICY outbox_select_admin ON public.outbox_events FOR SELECT TO sgr_app
  USING (public.sgr_is_operations_admin() OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS email_select_admin ON public.email_deliveries;
CREATE POLICY email_select_admin ON public.email_deliveries FOR SELECT TO sgr_app
  USING (public.sgr_is_operations_admin() OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS sla_state_select ON public.sla_evaluation_state;
CREATE POLICY sla_state_select ON public.sla_evaluation_state FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_operations_admin()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS proposals_write ON public.proposals;
CREATE POLICY proposals_write ON public.proposals FOR ALL TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (public.sgr_is_staff() OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER')
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (public.sgr_is_staff() OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER')
  );

RESET ROLE;
