-- Contract is a date, not a yes/no flag.
SET ROLE sgr_owner;

DROP FUNCTION IF EXISTS public.sgr_update_user_employment(uuid, date, boolean, integer);

ALTER TABLE public.users
  DROP COLUMN IF EXISTS "hasContract",
  ADD COLUMN "contractEndsOn" date;

GRANT SELECT ("contractEndsOn") ON public.users TO sgr_app;
GRANT SELECT ("contractEndsOn") ON public.users TO sgr_worker;

CREATE OR REPLACE FUNCTION public.sgr_update_user_employment(
  p_target_id uuid,
  p_hired_on date,
  p_contract_ends_on date,
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
  IF p_contract_ends_on IS NOT NULL AND (
    p_contract_ends_on < DATE '1950-01-01'
    OR p_contract_ends_on > DATE '2100-12-31'
    OR (p_hired_on IS NOT NULL AND p_contract_ends_on < p_hired_on)
  ) THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;

  UPDATE public.users
  SET
    "hiredOn" = p_hired_on,
    "contractEndsOn" = p_contract_ends_on,
    version = users.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = p_target_id
  RETURNING users.id, users.version
  INTO id, version;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_update_user_employment(uuid, date, date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_update_user_employment(uuid, date, date, integer) TO sgr_app;

RESET ROLE;
