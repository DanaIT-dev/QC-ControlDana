-- Two-token stored names are ambiguous: do not assume the first token is the last name.
SET ROLE sgr_owner;

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
    RAISE EXCEPTION 'Двухсловное ФИО требует подтверждения структуры: %', normalized
      USING ERRCODE = '22023';
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

DROP FUNCTION IF EXISTS public.sgr_create_pending_user(text, text, text, uuid, text, text);

CREATE FUNCTION public.sgr_create_pending_user(
  p_last_name text,
  p_first_name text,
  p_middle_name text,
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
  next_last text;
  next_first text;
  next_middle text;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_actor_id IS DISTINCT FROM public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  next_last := btrim(regexp_replace(normalize(coalesce(p_last_name, ''), NFKC), '\s+', ' ', 'g'));
  next_first := btrim(regexp_replace(normalize(coalesce(p_first_name, ''), NFKC), '\s+', ' ', 'g'));
  next_middle := nullif(
    btrim(regexp_replace(normalize(coalesce(p_middle_name, ''), NFKC), '\s+', ' ', 'g')),
    ''
  );
  IF next_last = '' OR next_first = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'Некорректные данные' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

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
    next_last,
    next_first,
    next_middle,
    next_last || ' ' || next_first || coalesce(' ' || next_middle, ''),
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

REVOKE ALL ON FUNCTION public.sgr_create_pending_user(text, text, text, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_create_pending_user(text, text, text, text, text, uuid, text, text) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_correct_user_name_structure(
  p_user_id uuid,
  p_last_name text,
  p_first_name text,
  p_middle_name text
)
RETURNS TABLE (
  last_name text,
  first_name text,
  middle_name text,
  full_name text,
  session_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  current_row public.users%ROWTYPE;
  updated_row public.users%ROWTYPE;
  next_last text;
  next_first text;
  next_middle text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Некорректные данные' USING ERRCODE = '22023';
  END IF;
  next_last := btrim(regexp_replace(normalize(coalesce(p_last_name, ''), NFKC), '\s+', ' ', 'g'));
  next_first := btrim(regexp_replace(normalize(coalesce(p_first_name, ''), NFKC), '\s+', ' ', 'g'));
  next_middle := nullif(
    btrim(regexp_replace(normalize(coalesce(p_middle_name, ''), NFKC), '\s+', ' ', 'g')),
    ''
  );
  IF next_last = '' OR next_first = '' THEN
    RAISE EXCEPTION 'Некорректные данные' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_row FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Пользователь не найден' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.users
  SET
    "lastName" = next_last,
    "firstName" = next_first,
    "middleName" = next_middle
  WHERE id = p_user_id
  RETURNING * INTO updated_row;

  INSERT INTO public.audit_logs (
    id,
    "actorUserId",
    "actorName",
    action,
    "entityType",
    "entityId",
    "oldValue",
    "newValue",
    reason,
    source,
    "occurredAt"
  ) VALUES (
    gen_random_uuid(),
    NULL,
    'system',
    'USER_NAME_STRUCTURE_CORRECTED',
    'USER',
    p_user_id::text,
    jsonb_build_object(
      'lastName', current_row."lastName",
      'firstName', current_row."firstName",
      'middleName', current_row."middleName",
      'fullName', current_row."fullName"
    ),
    jsonb_build_object(
      'lastName', updated_row."lastName",
      'firstName', updated_row."firstName",
      'middleName', updated_row."middleName",
      'fullName', updated_row."fullName"
    ),
    'confirmed two-token name mapping',
    'SYSTEM',
    clock_timestamp()
  );

  RETURN QUERY
  SELECT
    updated_row."lastName",
    updated_row."firstName",
    updated_row."middleName",
    updated_row."fullName",
    updated_row."sessionVersion";
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_correct_user_name_structure(uuid, text, text, text) FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;

RESET ROLE;
