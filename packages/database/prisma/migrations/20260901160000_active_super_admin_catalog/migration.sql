-- Owner/migrator catalog of active SUPER_ADMIN rows. Runtime roles cannot
-- execute this function, and it never returns passwordHash.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_active_super_admins()
RETURNS TABLE(email text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'sgr_owner', 'member') THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT u.email::text, u.status::text
  FROM public.users u
  WHERE u.role = 'SUPER_ADMIN'::public."UserRole"
    AND u.status = 'ACTIVE'::public."UserStatus"
  ORDER BY u.email;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_active_super_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_active_super_admins() TO sgr_owner;

RESET ROLE;
