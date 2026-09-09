-- Enum values for imported engineer matching and batch rollback.
SET ROLE sgr_owner;

ALTER TYPE public."ImportBatchStatus" ADD VALUE IF NOT EXISTS 'ROLLED_BACK';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'ImportedEngineerResolutionStatus'
  ) THEN
    CREATE TYPE public."ImportedEngineerResolutionStatus" AS ENUM (
      'UNMATCHED',
      'MATCHED',
      'AMBIGUOUS',
      'RESOLVED'
    );
  END IF;
END
$$;

RESET ROLE;
