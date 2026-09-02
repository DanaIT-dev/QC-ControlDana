-- Canonical directory engineer link on property_object_engineers.
-- sourceResponsibleEngineerName stays the immutable Excel value.
SET ROLE sgr_owner;

ALTER TABLE public.property_object_engineers
  ADD COLUMN IF NOT EXISTS "directoryLinkMethod" TEXT;

ALTER TABLE public.property_object_engineers
  DROP CONSTRAINT IF EXISTS property_object_engineers_directory_link_method_chk;

ALTER TABLE public.property_object_engineers
  ADD CONSTRAINT property_object_engineers_directory_link_method_chk
  CHECK (
    "directoryLinkMethod" IS NULL
    OR "directoryLinkMethod" IN ('AUTO_EXACT', 'ADMIN_CONFIRMED')
  );

CREATE UNIQUE INDEX IF NOT EXISTS property_object_engineers_active_directory_link_uidx
  ON public.property_object_engineers ("propertyObjectId")
  WHERE "unassignedAt" IS NULL AND "directoryLinkMethod" IS NOT NULL;

CREATE INDEX IF NOT EXISTS property_object_engineers_directory_link_idx
  ON public.property_object_engineers ("propertyObjectId")
  WHERE "directoryLinkMethod" IS NOT NULL;

DROP POLICY IF EXISTS objects_select ON public.property_objects;
CREATE POLICY objects_select ON public.property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

CREATE OR REPLACE FUNCTION public.sgr_guard_directory_engineer_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime boolean;
BEGIN
  runtime := current_setting('is_superuser', true) = 'off'
    AND NOT pg_has_role(current_user, 'sgr_owner', 'MEMBER');

  IF NOT runtime THEN
    RETURN NEW;
  END IF;

  IF current_setting('sgr.directory_link', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."directoryLinkMethod" IS NOT NULL THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."directoryLinkMethod" IS DISTINCT FROM OLD."directoryLinkMethod" THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_guard_directory_engineer_link() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_guard_directory_engineer_link() TO sgr_app;

DROP TRIGGER IF EXISTS trg_sgr_guard_directory_engineer_link ON public.property_object_engineers;
CREATE TRIGGER trg_sgr_guard_directory_engineer_link
  BEFORE INSERT OR UPDATE ON public.property_object_engineers
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_directory_engineer_link();

CREATE OR REPLACE FUNCTION public.sgr_directory_link_actor(
  p_actor_user_id uuid,
  p_actor_name text,
  OUT actor_id uuid,
  OUT actor_name text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime boolean;
  ctx_name text;
BEGIN
  runtime := pg_has_role(session_user, 'sgr_app', 'MEMBER')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER');

  IF runtime THEN
    IF NOT public.sgr_ctx_verified() OR NOT public.sgr_is_admin() THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_id := public.sgr_ctx_user_id();
    SELECT u."fullName" INTO ctx_name FROM public.users u WHERE u.id = actor_id;
    IF ctx_name IS NULL THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    actor_name := ctx_name;
    RETURN;
  END IF;

  IF NOT pg_has_role(session_user, 'sgr_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  actor_id := p_actor_user_id;
  actor_name := coalesce(nullif(p_actor_name, ''), 'system');
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_directory_link_actor(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.sgr_write_directory_engineer_audit(
  p_action text,
  p_object_id uuid,
  p_user_id uuid,
  p_actor_id uuid,
  p_actor_name text,
  p_method text,
  p_match_result text,
  p_request_id text,
  p_source public."AuditSource"
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  PERFORM public.sgr_insert_audit_log(
    p_actor_id,
    p_actor_name,
    p_action,
    'PROPERTY_OBJECT',
    p_object_id::text,
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'objectId', p_object_id,
      'userId', p_user_id,
      'actorId', p_actor_id,
      'method', p_method,
      'matchResult', p_match_result,
      'timestamp', clock_timestamp()
    ),
    NULL,
    p_source,
    clock_timestamp(),
    NULL,
    p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_write_directory_engineer_audit(
  text, uuid, uuid, uuid, text, text, text, text, public."AuditSource"
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.sgr_apply_directory_engineer_link(
  p_object_id uuid,
  p_user_id uuid,
  p_method text,
  p_match_result text,
  p_actor_user_id uuid,
  p_actor_name text,
  p_request_id text,
  p_source public."AuditSource" DEFAULT 'WEB'
)
RETURNS TABLE (
  changed boolean,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  actor_id uuid;
  actor_name text;
  target_role public."UserRole";
  target_status public."UserStatus";
  object_exists boolean;
  current_id uuid;
  current_user_id uuid;
  current_method text;
  current_unassigned timestamptz;
  existing_id uuid;
  existing_unassigned timestamptz;
  existing_method text;
  now_ts timestamptz := clock_timestamp();
  audit_action text;
BEGIN
  SELECT a.actor_id, a.actor_name
  INTO actor_id, actor_name
  FROM public.sgr_directory_link_actor(p_actor_user_id, p_actor_name) AS a;

  IF p_method IS DISTINCT FROM 'AUTO_EXACT' AND p_method IS DISTINCT FROM 'ADMIN_CONFIRMED' THEN
    RAISE EXCEPTION 'Некорректный способ связи' USING ERRCODE = '22023';
  END IF;
  IF p_match_result IS NULL OR p_match_result NOT IN ('MATCHED', 'UNMATCHED', 'AMBIGUOUS', 'INVALID') THEN
    RAISE EXCEPTION 'Некорректный результат сопоставления' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('sgr.directory_link', '1', true);

  SELECT true INTO object_exists FROM public.property_objects o WHERE o.id = p_object_id FOR UPDATE;
  IF object_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  SELECT u.role, u.status
  INTO target_role, target_status
  FROM public.users u
  WHERE u.id = p_user_id
  FOR UPDATE;

  IF target_role IS DISTINCT FROM 'RESPONSIBLE_ENGINEER' OR target_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'Назначить можно только активного ответственного инженера' USING ERRCODE = '22023';
  END IF;

  SELECT poe.id, poe."userId", poe."directoryLinkMethod", poe."unassignedAt"
  INTO current_id, current_user_id, current_method, current_unassigned
  FROM public.property_object_engineers poe
  WHERE poe."propertyObjectId" = p_object_id
    AND poe."unassignedAt" IS NULL
    AND poe."directoryLinkMethod" IS NOT NULL
  FOR UPDATE;

  IF current_id IS NOT NULL AND current_user_id = p_user_id THEN
    IF current_method IS NOT DISTINCT FROM p_method THEN
      changed := false;
      action := 'UNCHANGED';
      RETURN NEXT;
      RETURN;
    END IF;
    UPDATE public.property_object_engineers
    SET "directoryLinkMethod" = p_method
    WHERE id = current_id;
    PERFORM public.sgr_write_directory_engineer_audit(
      'PROPERTY_OBJECT_ENGINEER_LINK_CHANGED',
      p_object_id,
      p_user_id,
      actor_id,
      actor_name,
      p_method,
      p_match_result,
      p_request_id,
      p_source
    );
    changed := true;
    action := 'LINK_CHANGED';
    RETURN NEXT;
    RETURN;
  END IF;

  IF current_id IS NOT NULL THEN
    UPDATE public.property_object_engineers
    SET
      "unassignedAt" = now_ts,
      "directoryLinkMethod" = NULL
    WHERE id = current_id;
    audit_action := 'PROPERTY_OBJECT_ENGINEER_LINK_CHANGED';
  ELSE
    audit_action := 'PROPERTY_OBJECT_ENGINEER_LINKED';
  END IF;

  SELECT poe.id, poe."unassignedAt", poe."directoryLinkMethod"
  INTO existing_id, existing_unassigned, existing_method
  FROM public.property_object_engineers poe
  WHERE poe."propertyObjectId" = p_object_id
    AND poe."userId" = p_user_id
  FOR UPDATE;

  IF existing_id IS NULL THEN
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
      p_object_id,
      p_user_id,
      now_ts,
      NULL,
      actor_id,
      p_method
    );
  ELSE
    UPDATE public.property_object_engineers
    SET
      "unassignedAt" = NULL,
      "assignedAt" = CASE WHEN existing_unassigned IS NULL THEN "assignedAt" ELSE now_ts END,
      "assignedByUserId" = coalesce(actor_id, "assignedByUserId"),
      "directoryLinkMethod" = p_method
    WHERE id = existing_id;
  END IF;

  PERFORM public.sgr_write_directory_engineer_audit(
    audit_action,
    p_object_id,
    p_user_id,
    actor_id,
    actor_name,
    p_method,
    p_match_result,
    p_request_id,
    p_source
  );
  changed := true;
  action := CASE WHEN audit_action = 'PROPERTY_OBJECT_ENGINEER_LINKED' THEN 'LINKED' ELSE 'LINK_CHANGED' END;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_apply_directory_engineer_link(
  uuid, uuid, text, text, uuid, text, text, public."AuditSource"
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_apply_directory_engineer_link(
  uuid, uuid, text, text, uuid, text, text, public."AuditSource"
) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_clear_directory_engineer_link(
  p_object_id uuid,
  p_only_auto boolean,
  p_match_result text,
  p_actor_user_id uuid,
  p_actor_name text,
  p_request_id text,
  p_source public."AuditSource" DEFAULT 'WEB'
)
RETURNS TABLE (
  changed boolean,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  actor_id uuid;
  actor_name text;
  current_id uuid;
  current_user_id uuid;
  current_method text;
BEGIN
  SELECT a.actor_id, a.actor_name
  INTO actor_id, actor_name
  FROM public.sgr_directory_link_actor(p_actor_user_id, p_actor_name) AS a;

  PERFORM set_config('sgr.directory_link', '1', true);

  SELECT poe.id, poe."userId", poe."directoryLinkMethod"
  INTO current_id, current_user_id, current_method
  FROM public.property_object_engineers poe
  WHERE poe."propertyObjectId" = p_object_id
    AND poe."unassignedAt" IS NULL
    AND poe."directoryLinkMethod" IS NOT NULL
  FOR UPDATE;

  IF current_id IS NULL THEN
    changed := false;
    action := 'UNCHANGED';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_only_auto AND current_method IS DISTINCT FROM 'AUTO_EXACT' THEN
    changed := false;
    action := 'UNCHANGED';
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.property_object_engineers
  SET
    "unassignedAt" = clock_timestamp(),
    "directoryLinkMethod" = NULL
  WHERE id = current_id;

  PERFORM public.sgr_write_directory_engineer_audit(
    'PROPERTY_OBJECT_ENGINEER_UNLINKED',
    p_object_id,
    current_user_id,
    actor_id,
    actor_name,
    current_method,
    coalesce(p_match_result, 'UNMATCHED'),
    p_request_id,
    p_source
  );
  changed := true;
  action := 'UNLINKED';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_clear_directory_engineer_link(
  uuid, boolean, text, uuid, text, text, public."AuditSource"
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_clear_directory_engineer_link(
  uuid, boolean, text, uuid, text, text, public."AuditSource"
) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_revoke_engineer_object_access(
  p_user_id uuid,
  p_actor_user_id uuid,
  p_actor_name text,
  p_request_id text,
  p_source public."AuditSource" DEFAULT 'WEB'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  actor_id uuid;
  actor_name text;
  link_row record;
  revoked integer := 0;
BEGIN
  SELECT a.actor_id, a.actor_name
  INTO actor_id, actor_name
  FROM public.sgr_directory_link_actor(p_actor_user_id, p_actor_name) AS a;

  PERFORM set_config('sgr.directory_link', '1', true);

  FOR link_row IN
    SELECT poe.id, poe."propertyObjectId", poe."directoryLinkMethod"
    FROM public.property_object_engineers poe
    WHERE poe."userId" = p_user_id
      AND poe."unassignedAt" IS NULL
    FOR UPDATE
  LOOP
    UPDATE public.property_object_engineers
    SET "unassignedAt" = clock_timestamp()
    WHERE id = link_row.id;
    revoked := revoked + 1;
    IF link_row."directoryLinkMethod" IS NOT NULL THEN
      PERFORM public.sgr_write_directory_engineer_audit(
        'PROPERTY_OBJECT_ENGINEER_UNLINKED',
        link_row."propertyObjectId",
        p_user_id,
        actor_id,
        actor_name,
        link_row."directoryLinkMethod",
        'UNMATCHED',
        p_request_id,
        p_source
      );
    END IF;
  END LOOP;

  RETURN revoked;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_revoke_engineer_object_access(
  uuid, uuid, text, text, public."AuditSource"
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_revoke_engineer_object_access(
  uuid, uuid, text, text, public."AuditSource"
) TO sgr_app;

RESET ROLE;
