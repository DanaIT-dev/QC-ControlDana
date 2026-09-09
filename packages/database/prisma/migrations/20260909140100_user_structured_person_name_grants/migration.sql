-- Column-level SELECT for structured name fields. sgr_app/sgr_worker do not have table SELECT.
SET ROLE sgr_owner;

GRANT SELECT ("lastName", "firstName", "middleName") ON public.users TO sgr_app;
GRANT SELECT ("lastName", "firstName", "middleName") ON public.users TO sgr_worker;

RESET ROLE;
