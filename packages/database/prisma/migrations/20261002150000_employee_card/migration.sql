-- Employee card: birth date, hire date, contract, and the first-login completion flag.
-- Hire date and contract are written only by leaders and the administrator.
-- The employee fills name, phone, and birth date after the temporary password change.
SET ROLE sgr_owner;

ALTER TABLE public.users
  ADD COLUMN "birthDate" date,
  ADD COLUMN "hiredOn" date,
  ADD COLUMN "hasContract" boolean,
  ADD COLUMN "mustCompleteProfile" boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.sgr_complete_own_profile(
  p_last_name text,
  p_first_name text,
  p_middle_name text,
  p_full_name text,
  p_phone text,
  p_birth_date date
)
RETURNS TABLE (
  id uuid,
  full_name text,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  runtime boolean;
  actor_id uuid;
  target public.users%ROWTYPE;
  today_local date := (clock_timestamp() AT TIME ZONE 'Europe/Minsk')::date;
  next_phone text := btrim(p_phone);
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');
  IF runtime THEN
    IF NOT public.sgr_ctx_verified() THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
  ELSE
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF actor_id IS NULL
    OR nullif(btrim(p_last_name), '') IS NULL
    OR nullif(btrim(p_first_name), '') IS NULL
    OR nullif(btrim(p_full_name), '') IS NULL
    OR next_phone IS NULL
    OR char_length(next_phone) < 6
    OR char_length(next_phone) > 32
    OR p_birth_date IS NULL
    OR p_birth_date > today_local
    OR p_birth_date < DATE '1900-01-01'
  THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target FROM public.users WHERE users.id = actor_id FOR UPDATE;
  IF NOT FOUND OR target.status <> 'ACTIVE'::public."UserStatus" THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF NOT target."mustCompleteProfile" THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  UPDATE public.users
  SET
    "lastName" = btrim(p_last_name),
    "firstName" = btrim(p_first_name),
    "middleName" = nullif(btrim(coalesce(p_middle_name, '')), ''),
    "fullName" = btrim(p_full_name),
    phone = next_phone,
    "birthDate" = p_birth_date,
    "mustCompleteProfile" = false,
    version = users.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = actor_id
  RETURNING users.id, users."fullName", users.version
  INTO id, full_name, version;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_complete_own_profile(text, text, text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_complete_own_profile(text, text, text, text, text, date) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_update_user_employment(
  p_target_id uuid,
  p_hired_on date,
  p_has_contract boolean,
  p_expected_version integer
)
RETURNS TABLE (
  id uuid,
  version integer
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
  target public.users%ROWTYPE;
  today_local date := (clock_timestamp() AT TIME ZONE 'Europe/Minsk')::date;
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');
  IF runtime THEN
    IF NOT public.sgr_ctx_verified() THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
  ELSE
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  SELECT u.role INTO actor_role FROM public.users u WHERE u.id = actor_id;
  IF actor_role IS NULL OR actor_role NOT IN (
    'ADMIN'::public."UserRole",
    'MANAGER'::public."UserRole",
    'SGR_MANAGER'::public."UserRole"
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target FROM public.users WHERE users.id = p_target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF target.role = 'SUPER_ADMIN'::public."UserRole" THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF target.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем' USING ERRCODE = '40001';
  END IF;
  IF p_hired_on IS NOT NULL AND (
    p_hired_on < DATE '1950-01-01' OR p_hired_on > today_local + 366
  ) THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;

  UPDATE public.users
  SET
    "hiredOn" = p_hired_on,
    "hasContract" = p_has_contract,
    version = users.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = p_target_id
  RETURNING users.id, users.version
  INTO id, version;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_update_user_employment(uuid, date, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_update_user_employment(uuid, date, boolean, integer) TO sgr_app;
