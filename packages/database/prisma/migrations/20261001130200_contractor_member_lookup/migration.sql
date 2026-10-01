-- Resolve contractor notification recipients without exposing membership
-- administration to the acting engineer.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_contractor_member_ids(organization_ids uuid[])
RETURNS TABLE ("userId" uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF organization_ids IS NULL OR cardinality(organization_ids) = 0 THEN
    RETURN;
  END IF;
  IF NOT (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_staff()
    OR public.sgr_is_responsible()
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT m."userId"
  FROM public.user_organization_memberships m
  JOIN public.users u ON u.id = m."userId"
  WHERE m."organizationId" = ANY(organization_ids)
    AND m."revokedAt" IS NULL
    AND u.role = 'CONTRACTOR_ENGINEER'::public."UserRole"
    AND u.status = 'ACTIVE'::public."UserStatus";
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_contractor_member_ids(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_contractor_member_ids(uuid[]) TO sgr_app, sgr_worker;

RESET ROLE;
