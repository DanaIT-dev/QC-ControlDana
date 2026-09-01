-- Allow sgr_app to persist credentials in the same transaction as user
-- creation without GRANT on user_credentials. Direct table writes stay revoked.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_upsert_user_credentials(
  p_user_id uuid,
  p_password_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(session_user, 'sgr_auth', 'member') THEN
    NULL;
  ELSIF pg_has_role(session_user, 'sgr_app', 'member')
    AND public.sgr_is_admin()
    AND public.sgr_ctx_verified() THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.role <> 'SUPER_ADMIN'
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.user_credentials (
    "userId",
    "passwordHash",
    "passwordChangedAt",
    "createdAt",
    "updatedAt"
  ) VALUES (
    p_user_id,
    p_password_hash,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  )
  ON CONFLICT ("userId") DO UPDATE SET
    "passwordHash" = EXCLUDED."passwordHash",
    "passwordChangedAt" = EXCLUDED."passwordChangedAt",
    "updatedAt" = clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_upsert_user_credentials(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_upsert_user_credentials(uuid, text) TO sgr_app, sgr_auth;

RESET ROLE;
