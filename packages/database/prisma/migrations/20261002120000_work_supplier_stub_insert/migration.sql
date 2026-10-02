-- A contractor engineer may add a name-only work supplier from the proposal
-- dialog. Staff catalog writes stay on the existing policies.
SET ROLE sgr_owner;

CREATE POLICY org_insert_work_supplier ON public.organizations
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND unp IS NULL
    AND "postalAddress" IS NULL
    AND email IS NULL
    AND phone IS NULL
    AND "contactPerson" IS NULL
    AND active = true
  );

CREATE POLICY org_roles_insert_work_supplier ON public.organization_role_assignments
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND role = 'ALTERNATIVE_CONTRACTOR'
    AND NOT EXISTS (
      SELECT 1
      FROM public.organization_role_assignments existing
      WHERE existing."organizationId" = organization_role_assignments."organizationId"
        AND existing.role <> 'ALTERNATIVE_CONTRACTOR'
    )
  );
