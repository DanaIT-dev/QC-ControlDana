-- Directory of organizations that performed construction work.
-- Names stay on organizations. The two notes say who supplied the work
-- on the site and which work was carried out.
SET ROLE sgr_owner;

CREATE TABLE public.construction_work_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  "workSupplierOnObject" text,
  "workExecution" text,
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT construction_work_profiles_supplier_len CHECK (
    "workSupplierOnObject" IS NULL OR char_length("workSupplierOnObject") <= 1000
  ),
  CONSTRAINT construction_work_profiles_execution_len CHECK (
    "workExecution" IS NULL OR char_length("workExecution") <= 1000
  )
);

INSERT INTO public.construction_work_profiles (id, "organizationId")
SELECT gen_random_uuid(), organization.id
FROM public.organizations organization;

CREATE OR REPLACE FUNCTION public.sgr_create_construction_work_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.construction_work_profiles (id, "organizationId")
  VALUES (gen_random_uuid(), NEW.id)
  ON CONFLICT ("organizationId") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_create_construction_work_profile
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_create_construction_work_profile();

CREATE OR REPLACE FUNCTION public.sgr_guard_construction_work_profile()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER construction_work_profiles_guard
  BEFORE UPDATE ON public.construction_work_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_construction_work_profile();

CREATE OR REPLACE FUNCTION public.sgr_app_edit_construction_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() IN (
    'ADMIN', 'MANAGER', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER', 'CONTRACTOR_ENGINEER'
  )
$$;

REVOKE ALL ON FUNCTION public.sgr_create_construction_work_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_guard_construction_work_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_app_edit_construction_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_create_construction_work_profile() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_guard_construction_work_profile() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_app_edit_construction_work() TO sgr_app, sgr_worker;

ALTER TABLE public.construction_work_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.construction_work_profiles FORCE ROW LEVEL SECURITY;

GRANT SELECT, UPDATE ON public.construction_work_profiles TO sgr_app;
GRANT SELECT ON public.construction_work_profiles TO sgr_worker;

CREATE POLICY construction_work_select ON public.construction_work_profiles
  FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_ctx_verified() OR public.sgr_ctx_is_worker());

CREATE POLICY construction_work_update ON public.construction_work_profiles
  FOR UPDATE TO sgr_app
  USING (public.sgr_app_edit_construction_work())
  WITH CHECK (public.sgr_app_edit_construction_work());
