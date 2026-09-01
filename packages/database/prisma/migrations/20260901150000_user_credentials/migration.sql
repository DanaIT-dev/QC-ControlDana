-- Move password hashes off users into user_credentials. Existing hashes are
-- copied with INSERT ... SELECT and are not rewritten.
SET ROLE sgr_owner;

CREATE TABLE public.user_credentials (
  "userId" uuid PRIMARY KEY,
  "passwordHash" text NOT NULL,
  "passwordChangedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_userId_fkey
    FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE
);

INSERT INTO public.user_credentials (
  "userId",
  "passwordHash",
  "passwordChangedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  id,
  "passwordHash",
  "passwordChangedAt",
  "createdAt",
  "updatedAt"
FROM public.users
WHERE "passwordHash" IS NOT NULL
  AND btrim("passwordHash") <> '';

ALTER TABLE public.users DROP COLUMN "passwordHash";
ALTER TABLE public.users DROP COLUMN "passwordChangedAt";

ALTER TABLE public.user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credentials FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_credentials FROM PUBLIC;
REVOKE ALL ON TABLE public.user_credentials FROM sgr_app, sgr_auth, sgr_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_credentials TO sgr_auth;

CREATE POLICY user_credentials_auth_select ON public.user_credentials
  FOR SELECT TO sgr_auth
  USING (true);
CREATE POLICY user_credentials_auth_insert ON public.user_credentials
  FOR INSERT TO sgr_auth
  WITH CHECK (true);
CREATE POLICY user_credentials_auth_update ON public.user_credentials
  FOR UPDATE TO sgr_auth
  USING (true) WITH CHECK (true);

REVOKE SELECT ON public.users FROM sgr_app;
REVOKE SELECT ON public.users FROM sgr_worker;
GRANT SELECT (
  id,
  "fullName",
  email,
  phone,
  "mustChangePassword",
  "sessionVersion",
  "lastLoginAt",
  role,
  "roleBeforeAdmin",
  status,
  version,
  "createdAt",
  "updatedAt",
  "archivedAt"
) ON public.users TO sgr_app;
GRANT SELECT (
  id,
  "fullName",
  email,
  phone,
  "mustChangePassword",
  "sessionVersion",
  "lastLoginAt",
  role,
  "roleBeforeAdmin",
  status,
  version,
  "createdAt",
  "updatedAt",
  "archivedAt"
) ON public.users TO sgr_worker;

REVOKE UPDATE ON public.users FROM sgr_auth;
GRANT UPDATE (
  "lastLoginAt",
  "mustChangePassword",
  "sessionVersion",
  version,
  "updatedAt"
) ON public.users TO sgr_auth;

RESET ROLE;
