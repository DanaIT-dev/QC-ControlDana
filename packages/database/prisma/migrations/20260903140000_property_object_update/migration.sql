-- Protected property-object updates: no unrestricted UPDATE/DELETE for sgr_app.
SET ROLE sgr_owner;

DROP POLICY IF EXISTS objects_update ON public.property_objects;
DROP POLICY IF EXISTS objects_delete ON public.property_objects;
REVOKE UPDATE ON TABLE public.property_objects FROM sgr_app;
REVOKE DELETE ON TABLE public.property_objects FROM sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_update_property_object(
  p_id uuid,
  p_expected_version integer,
  p_name text,
  p_address text,
  p_active boolean,
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
  source_system text,
  source_row integer,
  source_import_key text,
  source_responsible_engineer_name text,
  active boolean,
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
  current public.property_objects%ROWTYPE;
  next_name text;
  next_address text;
  next_active boolean;
  status_changed boolean;
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

  PERFORM pg_advisory_xact_lock(20260903, 14);

  SELECT * INTO current
  FROM public.property_objects o
  WHERE o.id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;

  IF current.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.'
      USING ERRCODE = '40001';
  END IF;

  next_name := btrim(p_name);
  next_address := nullif(btrim(COALESCE(p_address, '')), '');
  next_active := COALESCE(p_active, current.active);
  status_changed := current.active IS DISTINCT FROM next_active;

  IF EXISTS (
    SELECT 1
    FROM public.property_objects o
    WHERE o.id <> p_id
      AND lower(o.name) = lower(next_name)
      AND lower(COALESCE(o.address, '')) = lower(COALESCE(next_address, ''))
  ) THEN
    RAISE EXCEPTION 'Объект с таким названием и адресом уже существует' USING ERRCODE = '23505';
  END IF;

  UPDATE public.property_objects o
  SET
    name = next_name,
    address = next_address,
    active = next_active,
    "archivedAt" = CASE
      WHEN next_active THEN NULL
      WHEN current.active THEN now_ts
      ELSE current."archivedAt"
    END,
    version = current.version + 1,
    "updatedAt" = now_ts
  WHERE o.id = p_id
    AND o.version = p_expected_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.'
      USING ERRCODE = '40001';
  END IF;

  PERFORM public.sgr_insert_audit_log(
    actor_id,
    actor_name,
    'PROPERTY_OBJECT_UPDATED',
    'PROPERTY_OBJECT',
    current.id::text,
    NULL,
    NULL,
    jsonb_build_object(
      'name', current.name,
      'address', current.address,
      'active', current.active
    ),
    jsonb_build_object(
      'name', next_name,
      'address', next_address,
      'active', next_active
    ),
    NULL,
    'WEB',
    now_ts,
    NULL,
    p_request_id
  );

  IF status_changed THEN
    PERFORM public.sgr_insert_audit_log(
      actor_id,
      actor_name,
      'PROPERTY_OBJECT_STATUS_CHANGED',
      'PROPERTY_OBJECT',
      current.id::text,
      NULL,
      NULL,
      jsonb_build_object('active', current.active),
      jsonb_build_object('active', next_active),
      NULL,
      'WEB',
      now_ts,
      NULL,
      p_request_id
    );
  END IF;

  SELECT * INTO current FROM public.property_objects o WHERE o.id = p_id;

  id := current.id;
  name := current.name;
  address := current.address;
  commissioned_at := current."commissionedAt";
  warranty_ends_at := current."warrantyEndsAt";
  sort_order := current."sortOrder";
  source_system := current."sourceSystem";
  source_row := current."sourceRow";
  source_import_key := current."sourceImportKey";
  source_responsible_engineer_name := current."sourceResponsibleEngineerName";
  active := current.active;
  version := current.version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_update_property_object(
  uuid, integer, text, text, boolean, uuid, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_update_property_object(
  uuid, integer, text, text, boolean, uuid, text, text
) TO sgr_app;

RESET ROLE;
