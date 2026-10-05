-- sgr_app and sgr_worker have column-level SELECT on users.
-- New card columns are invisible until they are granted explicitly.
SET ROLE sgr_owner;

GRANT SELECT ("birthDate", "hiredOn", "hasContract", "mustCompleteProfile")
  ON public.users TO sgr_app;
GRANT SELECT ("birthDate", "hiredOn", "hasContract", "mustCompleteProfile")
  ON public.users TO sgr_worker;

RESET ROLE;
