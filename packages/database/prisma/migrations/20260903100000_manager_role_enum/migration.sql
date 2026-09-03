-- Add MANAGER ("Руководитель"). The value is not referenced until the next migration.
SET ROLE sgr_owner;

ALTER TYPE public."UserRole" ADD VALUE IF NOT EXISTS 'MANAGER' AFTER 'ADMIN';

RESET ROLE;
