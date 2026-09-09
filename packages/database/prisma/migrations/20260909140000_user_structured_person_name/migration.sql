-- Structured person name columns. fullName stays for compatibility and is synced from parts.
SET ROLE sgr_owner;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS "lastName" TEXT,
  ADD COLUMN IF NOT EXISTS "firstName" TEXT,
  ADD COLUMN IF NOT EXISTS "middleName" TEXT;

CREATE OR REPLACE FUNCTION public.sgr_parse_stored_official_person_name(full_name text)
RETURNS TABLE (
  last_name text,
  first_name text,
  middle_name text
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized text;
  parts text[];
  token_pattern text := '^[[:alpha:]]+([ʼ''′][[:alpha:]]+)?(-[[:alpha:]]+([ʼ''′][[:alpha:]]+)?)?$';
  patronymic_pattern text := '(ович|евич|ёвич|ивич|овна|евна|ична|инична)$';
BEGIN
  normalized := btrim(regexp_replace(normalize(coalesce(full_name, ''), NFKC), '\s+', ' ', 'g'));
  IF normalized = '' THEN
    RAISE EXCEPTION 'Неоднозначное ФИО' USING ERRCODE = '22023';
  END IF;
  parts := regexp_split_to_array(normalized, ' ');
  IF EXISTS (
    SELECT 1 FROM unnest(parts) AS token
    WHERE token !~ token_pattern
  ) THEN
    RAISE EXCEPTION 'Неоднозначное ФИО: %', normalized USING ERRCODE = '22023';
  END IF;
  IF array_length(parts, 1) = 2 THEN
    last_name := parts[1];
    first_name := parts[2];
    middle_name := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF array_length(parts, 1) = 3 AND parts[3] ~* patronymic_pattern THEN
    last_name := parts[1];
    first_name := parts[2];
    middle_name := parts[3];
    RETURN NEXT;
    RETURN;
  END IF;
  RAISE EXCEPTION 'Неоднозначное ФИО: %', normalized USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_parse_stored_official_person_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_parse_stored_official_person_name(text) TO sgr_app, sgr_worker, sgr_owner;

DO $$
DECLARE
  parsed record;
  composed text;
BEGIN
  FOR parsed IN
    SELECT
      u."fullName" AS source_full,
      p.last_name,
      p.first_name,
      p.middle_name
    FROM public.users u
    CROSS JOIN LATERAL public.sgr_parse_stored_official_person_name(u."fullName") p
  LOOP
    composed := parsed.last_name || ' ' || parsed.first_name || coalesce(' ' || parsed.middle_name, '');
    IF composed IS DISTINCT FROM parsed.source_full THEN
      RAISE EXCEPTION 'Неоднозначное ФИО: %', parsed.source_full USING ERRCODE = '22023';
    END IF;
  END LOOP;
END
$$;

UPDATE public.users AS u
SET
  "lastName" = parsed.last_name,
  "firstName" = parsed.first_name,
  "middleName" = parsed.middle_name
FROM public.users AS src
CROSS JOIN LATERAL public.sgr_parse_stored_official_person_name(src."fullName") AS parsed
WHERE u.id = src.id
  AND (u."lastName" IS NULL OR u."firstName" IS NULL);

ALTER TABLE public.users
  ALTER COLUMN "lastName" SET NOT NULL,
  ALTER COLUMN "firstName" SET NOT NULL;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_last_name_present_chk,
  DROP CONSTRAINT IF EXISTS users_first_name_present_chk,
  DROP CONSTRAINT IF EXISTS users_middle_name_empty_chk;

ALTER TABLE public.users
  ADD CONSTRAINT users_last_name_present_chk CHECK (btrim("lastName") <> ''),
  ADD CONSTRAINT users_first_name_present_chk CHECK (btrim("firstName") <> ''),
  ADD CONSTRAINT users_middle_name_empty_chk CHECK (
    "middleName" IS NULL OR btrim("middleName") <> ''
  );

CREATE INDEX IF NOT EXISTS users_last_first_middle_idx
  ON public.users ("lastName", "firstName", "middleName");

CREATE OR REPLACE FUNCTION public.sgr_sync_user_official_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_last text;
  next_first text;
  next_middle text;
BEGIN
  next_last := btrim(regexp_replace(normalize(coalesce(NEW."lastName", ''), NFKC), '\s+', ' ', 'g'));
  next_first := btrim(regexp_replace(normalize(coalesce(NEW."firstName", ''), NFKC), '\s+', ' ', 'g'));
  next_middle := nullif(
    btrim(regexp_replace(normalize(coalesce(NEW."middleName", ''), NFKC), '\s+', ' ', 'g')),
    ''
  );
  IF next_last = '' OR next_first = '' THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;
  NEW."lastName" := next_last;
  NEW."firstName" := next_first;
  NEW."middleName" := next_middle;
  NEW."fullName" := next_last || ' ' || next_first || coalesce(' ' || next_middle, '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_sync_official_name ON public.users;
CREATE TRIGGER users_sync_official_name
  BEFORE INSERT OR UPDATE OF "lastName", "firstName", "middleName", "fullName"
  ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_sync_user_official_name();

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
    OR NEW."lastName" IS DISTINCT FROM OLD."lastName"
    OR NEW."firstName" IS DISTINCT FROM OLD."firstName"
    OR NEW."middleName" IS DISTINCT FROM OLD."middleName"
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
  changed_name := next_full IS DISTINCT FROM target."fullName"
    OR next_last IS DISTINCT FROM target."lastName"
    OR next_first IS DISTINCT FROM target."firstName"
    OR next_middle IS DISTINCT FROM target."middleName";

  PERFORM set_config('sgr.profile_update', '1', true);
  UPDATE public.users
  SET
    "lastName" = next_last,
    "firstName" = next_first,
    "middleName" = next_middle,
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
        'lastName', target."lastName",
        'firstName', target."firstName",
        'middleName', target."middleName",
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
        'lastName', next_last,
        'firstName', next_first,
        'middleName', next_middle,
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

CREATE OR REPLACE FUNCTION public.sgr_create_pending_user(
  p_full_name text,
  p_email text,
  p_password_hash text,
  p_actor_id uuid,
  p_actor_name text,
  p_request_id text
)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  must_change_password boolean,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  last_login_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  created public.users%ROWTYPE;
  parsed record;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_actor_id IS DISTINCT FROM public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'Некорректные данные' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO parsed FROM public.sgr_parse_stored_official_person_name(p_full_name);

  INSERT INTO public.users (
    id,
    "lastName",
    "firstName",
    "middleName",
    "fullName",
    email,
    role,
    status,
    "mustChangePassword",
    "sessionVersion",
    version,
    "createdAt",
    "updatedAt"
  ) VALUES (
    gen_random_uuid(),
    parsed.last_name,
    parsed.first_name,
    parsed.middle_name,
    p_full_name,
    p_email,
    'PENDING_ROLE',
    'ACTIVE',
    true,
    1,
    1,
    clock_timestamp(),
    clock_timestamp()
  )
  RETURNING * INTO created;

  INSERT INTO public.user_credentials (
    "userId",
    "passwordHash",
    "passwordChangedAt",
    "createdAt",
    "updatedAt"
  ) VALUES (
    created.id,
    p_password_hash,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  );

  INSERT INTO public.audit_logs (
    id,
    "actorUserId",
    "actorName",
    action,
    "entityType",
    "entityId",
    "oldValue",
    "newValue",
    source,
    "occurredAt",
    "requestId"
  ) VALUES (
    gen_random_uuid(),
    p_actor_id,
    p_actor_name,
    'USER_CREATED_PENDING_ROLE',
    'USER',
    created.id::text,
    NULL,
    jsonb_build_object(
      'fullName', created."fullName",
      'lastName', created."lastName",
      'firstName', created."firstName",
      'middleName', created."middleName",
      'email', created.email,
      'role', 'PENDING_ROLE',
      'status', 'ACTIVE',
      'targetUserId', created.id
    ),
    'WEB',
    clock_timestamp(),
    p_request_id
  );

  RETURN QUERY
  SELECT
    created.id,
    created."fullName",
    created.email,
    created.role,
    created.status,
    created."archivedAt",
    created."mustChangePassword",
    created.version,
    created."createdAt",
    created."updatedAt",
    created."lastLoginAt";
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_create_pending_user(text, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_create_pending_user(text, text, text, uuid, text, text) TO sgr_app;

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
      OR public.sgr_person_search_blob(u."fullName") ILIKE '%' || needle || '%'
      OR u.email ILIKE '%' || needle || '%'
    )
  ORDER BY u."lastName" ASC, u."firstName" ASC, u.id ASC
  LIMIT 100;
END;
$$;

RESET ROLE;
