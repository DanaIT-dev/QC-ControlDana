-- Operational directories, manual object creation, and read-only system status probes.
SET ROLE sgr_owner;

ALTER TABLE public.organizations
  ALTER COLUMN "postalAddress" DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN phone DROP NOT NULL,
  ALTER COLUMN "contactPerson" DROP NOT NULL;

ALTER TABLE public.defect_items
  ADD COLUMN IF NOT EXISTS "workTypeId" UUID;

ALTER TABLE public.defect_items
  DROP CONSTRAINT IF EXISTS defect_items_workTypeId_fkey;

ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_workTypeId_fkey
  FOREIGN KEY ("workTypeId") REFERENCES public.work_types(id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS defect_items_workTypeId_idx
  ON public.defect_items ("workTypeId");

ALTER TABLE public.property_objects
  DROP CONSTRAINT IF EXISTS property_objects_source_identity_chk;

ALTER TABLE public.property_objects
  ADD CONSTRAINT property_objects_source_identity_chk CHECK (
    (
      "sourceSystem" IS NULL
      AND "sourceImportKey" IS NULL
      AND "sourceRow" IS NULL
    )
    OR (
      "sourceSystem" = 'MANUAL'
      AND "sourceImportKey" IS NULL
      AND "sourceRow" IS NULL
    )
    OR (
      "sourceSystem" IS NOT NULL
      AND "sourceSystem" <> 'MANUAL'
      AND "sourceImportKey" IS NOT NULL
      AND "sourceRow" IS NOT NULL
    )
  );

DROP INDEX IF EXISTS public.property_objects_name_lower_unique;

CREATE UNIQUE INDEX IF NOT EXISTS property_objects_name_address_unique
  ON public.property_objects (lower(name), lower(COALESCE(address, '')));

DROP POLICY IF EXISTS objects_write ON public.property_objects;
REVOKE INSERT ON TABLE public.property_objects FROM sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_create_property_object(
  p_name text,
  p_address text,
  p_commissioned_at timestamptz,
  p_warranty_ends_at timestamptz,
  p_engineer_user_id uuid,
  p_engineer_name text,
  p_actor_user_id uuid,
  p_actor_name text,
  p_request_id text
)
RETURNS TABLE (
  id uuid,
  name text,
  address text,
  commissioned_at timestamptz,
  warranty_ends_at timestamptz,
  sort_order integer,
  source_responsible_engineer_name text,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  runtime boolean;
  actor_id uuid;
  actor_name text;
  next_order integer;
  created public.property_objects%ROWTYPE;
  target_role public."UserRole";
  target_status public."UserStatus";
  now_ts timestamptz := clock_timestamp();
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');

  IF runtime THEN
    IF NOT public.sgr_ctx_verified() OR NOT public.sgr_is_staff() THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
    SELECT u."fullName" INTO actor_name FROM public.users u WHERE u.id = actor_id;
    IF actor_name IS NULL THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF p_actor_user_id IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := p_actor_user_id;
    actor_name := coalesce(nullif(p_actor_name, ''), 'system');
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Значение обязательно' USING ERRCODE = '22023';
  END IF;
  IF p_commissioned_at IS NOT NULL AND p_warranty_ends_at IS NOT NULL
     AND p_warranty_ends_at::date < p_commissioned_at::date THEN
    RAISE EXCEPTION 'Дата окончания гарантии не может быть раньше даты приёмки' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(20260902, 14);

  IF EXISTS (
    SELECT 1
    FROM public.property_objects o
    WHERE lower(o.name) = lower(btrim(p_name))
      AND lower(COALESCE(o.address, '')) = lower(COALESCE(nullif(btrim(COALESCE(p_address, '')), ''), ''))
  ) THEN
    RAISE EXCEPTION 'Объект с таким названием и адресом уже существует' USING ERRCODE = '23505';
  END IF;

  SELECT COALESCE(MAX(o."sortOrder"), 0) + 1 INTO next_order FROM public.property_objects o;

  INSERT INTO public.property_objects (
    id,
    name,
    address,
    "commissionedAt",
    "warrantyEndsAt",
    "sortOrder",
    "sourceResponsibleEngineerName",
    "sourceSystem",
    "sourceRow",
    "sourceImportKey",
    active,
    version,
    "createdAt",
    "updatedAt"
  ) VALUES (
    gen_random_uuid(),
    btrim(p_name),
    nullif(btrim(COALESCE(p_address, '')), ''),
    p_commissioned_at,
    p_warranty_ends_at,
    next_order,
    CASE WHEN p_engineer_user_id IS NULL THEN nullif(btrim(COALESCE(p_engineer_name, '')), '') ELSE NULL END,
    'MANUAL',
    NULL,
    NULL,
    true,
    1,
    now_ts,
    now_ts
  )
  RETURNING * INTO created;

  IF p_engineer_user_id IS NOT NULL THEN
    SELECT u.role, u.status
    INTO target_role, target_status
    FROM public.users u
    WHERE u.id = p_engineer_user_id
    FOR UPDATE;
    IF target_role IS DISTINCT FROM 'RESPONSIBLE_ENGINEER' OR target_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'Назначить можно только активного ответственного инженера' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('sgr.directory_link', '1', true);
    INSERT INTO public.property_object_engineers (
      id,
      "propertyObjectId",
      "userId",
      "assignedAt",
      "unassignedAt",
      "assignedByUserId",
      "directoryLinkMethod"
    ) VALUES (
      gen_random_uuid(),
      created.id,
      p_engineer_user_id,
      now_ts,
      NULL,
      actor_id,
      'ADMIN_CONFIRMED'
    );
  END IF;

  PERFORM public.sgr_insert_audit_log(
    actor_id,
    actor_name,
    'PROPERTY_OBJECT_CREATED',
    'PROPERTY_OBJECT',
    created.id::text,
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'name', created.name,
      'address', created.address,
      'sourceSystem', 'MANUAL',
      'responsibleEngineerId', p_engineer_user_id,
      'responsibleEngineerName', created."sourceResponsibleEngineerName",
      'timestamp', now_ts
    ),
    NULL,
    'WEB',
    now_ts,
    NULL,
    p_request_id
  );

  id := created.id;
  name := created.name;
  address := created.address;
  commissioned_at := created."commissionedAt";
  warranty_ends_at := created."warrantyEndsAt";
  sort_order := created."sortOrder";
  source_responsible_engineer_name := created."sourceResponsibleEngineerName";
  version := created.version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_create_property_object(
  text, text, timestamptz, timestamptz, uuid, text, uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_create_property_object(
  text, text, timestamptz, timestamptz, uuid, text, uuid, text, text
) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_migration_health()
RETURNS TABLE (
  status text,
  pending integer,
  failed integer,
  last_finished_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  pending_count integer := 0;
  failed_count integer := 0;
  last_finished timestamptz;
BEGIN
  IF NOT public.sgr_ctx_verified() OR NOT (
    public.sgr_is_admin() OR public.sgr_is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF to_regclass('public._prisma_migrations') IS NULL THEN
    status := 'down';
    pending := 0;
    failed := 0;
    last_finished_at := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::integer,
    COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL)::integer,
    MAX(finished_at)
  INTO pending_count, failed_count, last_finished
  FROM public._prisma_migrations;

  pending := pending_count;
  failed := failed_count;
  last_finished_at := last_finished;
  IF failed_count > 0 THEN
    status := 'down';
  ELSIF pending_count > 0 THEN
    status := 'degraded';
  ELSE
    status := 'up';
  END IF;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_migration_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_migration_health() TO sgr_app;

RESET ROLE;
