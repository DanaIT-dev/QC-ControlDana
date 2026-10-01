-- Add PENDING_INSPECTION before later statements use the value.
DO $$
DECLARE
  owner_name text;
BEGIN
  SELECT r.rolname
  INTO owner_name
  FROM pg_type t
  JOIN pg_roles r ON r.oid = t.typowner
  WHERE t.typname = 'DefectItemStatus'
    AND t.typnamespace = 'public'::regnamespace;
  IF owner_name IS DISTINCT FROM 'sgr_owner' THEN
    EXECUTE 'ALTER TYPE public."DefectItemStatus" OWNER TO sgr_owner';
  END IF;
END
$$;

SET ROLE sgr_owner;
ALTER TYPE public."DefectItemStatus" ADD VALUE IF NOT EXISTS 'PENDING_INSPECTION' AFTER 'IN_PROGRESS';
RESET ROLE;
