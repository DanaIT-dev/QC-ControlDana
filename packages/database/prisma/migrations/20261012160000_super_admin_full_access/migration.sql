-- SUPER_ADMIN can read and write business data. Catalog rows can be deleted.

CREATE OR REPLACE FUNCTION public.sgr_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SGR_MANAGER', 'SUPER_ADMIN')
$$;

CREATE OR REPLACE FUNCTION public.sgr_is_operations_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SUPER_ADMIN')
$$;

CREATE OR REPLACE FUNCTION public.sgr_is_business_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IS DISTINCT FROM 'PENDING_ROLE'
    AND public.sgr_ctx_role() IS DISTINCT FROM 'UNASSIGNED'
$$;

CREATE OR REPLACE FUNCTION public.sgr_app_create_act()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() IN (
    'ADMIN', 'MANAGER', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER', 'SUPER_ADMIN'
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_app_edit_construction_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() IN (
    'ADMIN', 'MANAGER', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER', 'CONTRACTOR_ENGINEER', 'SUPER_ADMIN'
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_start_act(p_act_id uuid, p_request_id text)
RETURNS TABLE(
  id uuid,
  status text,
  started_at timestamp with time zone,
  started_by_id uuid,
  started_by_name text,
  version integer,
  already_started boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
SET row_security TO off
AS $$
DECLARE
  actor_id uuid;
  actor_role public."UserRole";
  actor_name text;
  actor_status public."UserStatus";
  locked public.acts%ROWTYPE;
  starter_name text;
  previous_status public."ActStatus";
BEGIN
  IF NOT public.sgr_ctx_verified() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  actor_id := public.sgr_ctx_user_id();
  actor_role := public.sgr_ctx_role();

  SELECT u."fullName", u.status
  INTO actor_name, actor_status
  FROM public.users u
  WHERE u.id = actor_id;

  IF actor_id IS NULL OR actor_name IS NULL OR actor_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF actor_role IS DISTINCT FROM 'ADMIN'
    AND actor_role IS DISTINCT FROM 'MANAGER'
    AND actor_role IS DISTINCT FROM 'SGR_MANAGER'
    AND actor_role IS DISTINCT FROM 'RESPONSIBLE_ENGINEER'
    AND actor_role IS DISTINCT FROM 'SUPER_ADMIN'
  THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  SELECT a.*
  INTO locked
  FROM public.acts a
  WHERE a.id = p_act_id
  FOR UPDATE;

  IF NOT FOUND OR locked.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  IF actor_role = 'RESPONSIBLE_ENGINEER' AND NOT public.sgr_object_assigned(locked."objectId") THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  IF locked."startedAt" IS NOT NULL THEN
    SELECT u."fullName"
    INTO starter_name
    FROM public.users u
    WHERE u.id = locked."startedById";

    RETURN QUERY
    SELECT
      locked.id,
      locked.status::text,
      locked."startedAt",
      locked."startedById",
      starter_name,
      locked.version,
      true;
    RETURN;
  END IF;

  previous_status := locked.status;

  UPDATE public.acts
  SET
    status = 'IN_PROGRESS',
    "startedAt" = clock_timestamp(),
    "startedById" = actor_id,
    version = locked.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE public.acts.id = locked.id
  RETURNING * INTO locked;

  INSERT INTO public.audit_logs (
    id,
    "actorUserId",
    "actorName",
    action,
    "entityType",
    "entityId",
    "oldValue",
    "newValue",
    source,
    "occurredAt",
    "requestId"
  ) VALUES (
    gen_random_uuid(),
    actor_id,
    actor_name,
    'ACT_STARTED',
    'ACT',
    locked.id::text,
    jsonb_build_object('status', previous_status::text),
    jsonb_build_object(
      'status', 'IN_PROGRESS',
      'startedAt', locked."startedAt",
      'startedById', locked."startedById"
    ),
    'WEB',
    clock_timestamp(),
    p_request_id
  );

  RETURN QUERY
  SELECT
    locked.id,
    locked.status::text,
    locked."startedAt",
    locked."startedById",
    actor_name,
    locked.version,
    false;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_guard_user_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
DECLARE
  actor_role public."UserRole";
  actor_id uuid;
  profile_update boolean := current_setting('sgr.profile_update', true) IS NOT DISTINCT FROM '1';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'sgr_app', 'member')
      AND NOT pg_has_role(current_user, 'sgr_owner', 'member')
      AND OLD.role IN ('ADMIN', 'SUPER_ADMIN', 'MANAGER')
      AND (
        public.sgr_ctx_role() IS DISTINCT FROM 'SUPER_ADMIN'
        OR OLD.role = 'SUPER_ADMIN'
      ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.role = 'UNASSIGNED'::public."UserRole" THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF NEW.role = 'ADMIN'::public."UserRole" AND NEW."roleBeforeAdmin" IS NULL THEN
    NEW."roleBeforeAdmin" := 'UNASSIGNED'::public."UserRole";
  END IF;
  IF NEW.role IS DISTINCT FROM 'ADMIN'::public."UserRole" THEN
    NEW."roleBeforeAdmin" := NULL;
  END IF;

  IF pg_has_role(current_user, 'sgr_owner', 'member') THEN
    RETURN NEW;
  END IF;

  IF NOT pg_has_role(current_user, 'sgr_app', 'member') THEN
    RETURN NEW;
  END IF;

  actor_role := public.sgr_ctx_role()::public."UserRole";
  actor_id := public.sgr_ctx_user_id();

  IF actor_role = 'SUPER_ADMIN'::public."UserRole" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('ADMIN', 'SUPER_ADMIN', 'UNASSIGNED', 'PENDING_ROLE') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF public.sgr_role_rank(NEW.role) >= public.sgr_role_rank(actor_role) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF NOT profile_update AND (
    NEW."fullName" IS DISTINCT FROM OLD."fullName"
    OR NEW."lastName" IS DISTINCT FROM OLD."lastName"
    OR NEW."firstName" IS DISTINCT FROM OLD."firstName"
    OR NEW."middleName" IS DISTINCT FROM OLD."middleName"
    OR NEW.email IS DISTINCT FROM OLD.email
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF current_setting('sgr.admin_grant', true) IS DISTINCT FROM '1' THEN
    IF OLD.role = 'ADMIN' AND (
      NEW.role IS DISTINCT FROM OLD.role
      OR NEW.status IS DISTINCT FROM OLD.status
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role = 'ADMIN' AND OLD.role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role = 'PENDING_ROLE' AND OLD.role IS DISTINCT FROM 'PENDING_ROLE' THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF actor_id IS NOT DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
      IF public.sgr_role_rank(OLD.role) >= public.sgr_role_rank(actor_role)
        OR public.sgr_role_rank(NEW.role) >= public.sgr_role_rank(actor_role) THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF actor_id IS NOT DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
      IF public.sgr_role_rank(OLD.role) >= public.sgr_role_rank(actor_role) THEN
        RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS memberships_insert ON public.user_organization_memberships;
CREATE POLICY memberships_insert ON public.user_organization_memberships
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SUPER_ADMIN')
  );

DROP POLICY IF EXISTS memberships_update ON public.user_organization_memberships;
CREATE POLICY memberships_update ON public.user_organization_memberships
  FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SUPER_ADMIN')
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER', 'SUPER_ADMIN')
  );

GRANT DELETE ON public.property_objects TO sgr_app;
GRANT DELETE ON public.construction_work_profiles TO sgr_app;

DROP POLICY IF EXISTS objects_delete ON public.property_objects;
CREATE POLICY objects_delete ON public.property_objects
  FOR DELETE TO sgr_app
  USING (public.sgr_app_mutate_catalog());

DROP POLICY IF EXISTS construction_work_delete ON public.construction_work_profiles;
CREATE POLICY construction_work_delete ON public.construction_work_profiles
  FOR DELETE TO sgr_app
  USING (public.sgr_app_edit_construction_work());
