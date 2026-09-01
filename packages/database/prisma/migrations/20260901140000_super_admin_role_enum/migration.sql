-- Add SUPER_ADMIN to UserRole. Must commit before later statements use the value.
-- Type may be owned by sgr_migrator (fresh migrate) or sgr_owner (after role provision).
DO $$
DECLARE
  owner_name text;
BEGIN
  SELECT r.rolname
  INTO owner_name
  FROM pg_type t
  JOIN pg_roles r ON r.oid = t.typowner
  WHERE t.typname = 'UserRole'
    AND t.typnamespace = 'public'::regnamespace;
  IF owner_name IS DISTINCT FROM 'sgr_owner' THEN
    EXECUTE 'ALTER TYPE public."UserRole" OWNER TO sgr_owner';
  END IF;
END
$$;

SET ROLE sgr_owner;
ALTER TYPE public."UserRole" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
RESET ROLE;
