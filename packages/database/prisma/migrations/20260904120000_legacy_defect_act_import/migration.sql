-- Add imported act status. The value is committed before it is referenced.
SET ROLE sgr_owner;

ALTER TYPE public."ActStatus" ADD VALUE IF NOT EXISTS 'IMPORTED_UNSPECIFIED' AFTER 'NEW';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ImportBatchStatus') THEN
    CREATE TYPE public."ImportBatchStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED');
  END IF;
END
$$;

RESET ROLE;
