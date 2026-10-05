-- New attachment category must be committed before later migrations use it.
DO $$
DECLARE
  owner_name text;
BEGIN
  SELECT r.rolname
  INTO owner_name
  FROM pg_type t
  JOIN pg_roles r ON r.oid = t.typowner
  WHERE t.typname = 'AttachmentCategory'
    AND t.typnamespace = 'public'::regnamespace;
  IF owner_name IS DISTINCT FROM 'sgr_owner' THEN
    EXECUTE 'ALTER TYPE public."AttachmentCategory" OWNER TO sgr_owner';
  END IF;
END
$$;

SET ROLE sgr_owner;
ALTER TYPE public."AttachmentCategory" ADD VALUE IF NOT EXISTS 'REPAIR_EVIDENCE';
RESET ROLE;
