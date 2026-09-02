-- Add pending/unassigned application roles. Values are not used until the next migration.
SET ROLE sgr_owner;

ALTER TYPE public."UserRole" ADD VALUE IF NOT EXISTS 'PENDING_ROLE';
ALTER TYPE public."UserRole" ADD VALUE IF NOT EXISTS 'UNASSIGNED';

RESET ROLE;
