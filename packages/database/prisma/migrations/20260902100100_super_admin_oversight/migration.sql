-- SUPER_ADMIN read-only oversight, PENDING_ROLE identities, and narrow write definers.
SET ROLE sgr_owner;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_before_admin_chk;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_before_admin_chk CHECK (
    role <> 'UNASSIGNED'::public."UserRole"
    AND (
      (
        role = 'ADMIN'::public."UserRole"
        AND "roleBeforeAdmin" IN (
          'SGR_MANAGER'::public."UserRole",
          'RESPONSIBLE_ENGINEER'::public."UserRole",
          'CONTRACTOR_ENGINEER'::public."UserRole",
          'UNASSIGNED'::public."UserRole"
        )
      )
      OR (
        role <> 'ADMIN'::public."UserRole"
        AND "roleBeforeAdmin" IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION public.sgr_is_business_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IS DISTINCT FROM 'SUPER_ADMIN'
    AND public.sgr_ctx_role() IS DISTINCT FROM 'PENDING_ROLE'
    AND public.sgr_ctx_role() IS DISTINCT FROM 'UNASSIGNED'
$$;

CREATE OR REPLACE FUNCTION public.sgr_guard_user_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'sgr_app', 'member')
      AND NOT pg_has_role(current_user, 'sgr_owner', 'member')
      AND OLD.role IN ('ADMIN', 'SUPER_ADMIN') THEN
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

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
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
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_super_admin_directory(p_kind text, p_search text)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  needle text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    u.id,
    u."fullName",
    u.email,
    u.role,
    u.status,
    u."archivedAt",
    u.version
  FROM public.users u
  WHERE
    (
      (p_kind = 'admins' AND u.role = 'ADMIN' AND u.status = 'ACTIVE')
      OR (
        p_kind = 'eligible'
        AND u.status = 'ACTIVE'
        AND u."archivedAt" IS NULL
        AND u.role IN (
          'SGR_MANAGER',
          'RESPONSIBLE_ENGINEER',
          'CONTRACTOR_ENGINEER',
          'PENDING_ROLE'
        )
      )
    )
    AND (
      needle IS NULL
      OR u."fullName" ILIKE '%' || needle || '%'
      OR u.email ILIKE '%' || needle || '%'
    )
  ORDER BY u."fullName" ASC, u.id ASC
  LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_grant_admin(target_id uuid, expected_version integer)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  previous_role public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  target public.users%ROWTYPE;
  stored_previous public."UserRole";
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF target_id IS NULL OR target_id = public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target FROM public.users WHERE users.id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF expected_version IS NOT NULL AND target.version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  IF target.role = 'ADMIN' AND target.status = 'ACTIVE' THEN
    RETURN QUERY SELECT
      target.id,
      target."fullName",
      target.email,
      target.role,
      target."roleBeforeAdmin",
      target.status,
      target."archivedAt",
      target.version;
    RETURN;
  END IF;

  IF target.status IS DISTINCT FROM 'ACTIVE'
    OR target."archivedAt" IS NOT NULL
    OR target.role NOT IN (
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
      'PENDING_ROLE'
    ) THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  stored_previous := CASE
    WHEN target.role = 'PENDING_ROLE'::public."UserRole" THEN 'UNASSIGNED'::public."UserRole"
    ELSE target.role
  END;

  PERFORM set_config('sgr.admin_grant', '1', true);
  UPDATE public.users
  SET
    role = 'ADMIN',
    "roleBeforeAdmin" = stored_previous,
    "sessionVersion" = target."sessionVersion" + 1,
    version = target.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = target_id;

  RETURN QUERY
  SELECT u.id, u."fullName", u.email, u.role, u."roleBeforeAdmin", u.status, u."archivedAt", u.version
  FROM public.users u
  WHERE u.id = target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_revoke_admin(target_id uuid, expected_version integer)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  previous_role public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  target public.users%ROWTYPE;
  restored public."UserRole";
  active_count integer;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF target_id IS NULL OR target_id = public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Нельзя назначить эту учётную запись администратором' USING ERRCODE = '22023';
  END IF;

  PERFORM admin_users.id
  FROM public.users AS admin_users
  WHERE admin_users.role = 'ADMIN' AND admin_users.status = 'ACTIVE'
  FOR UPDATE;

  SELECT * INTO target FROM public.users WHERE users.id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Запись не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF expected_version IS NOT NULL AND target.version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'Запись изменена другим пользователем. Обновите данные и повторите.' USING ERRCODE = '40001';
  END IF;

  IF target.role IS DISTINCT FROM 'ADMIN' THEN
    RETURN QUERY SELECT
      target.id,
      target."fullName",
      target.email,
      target.role,
      target."roleBeforeAdmin",
      target.status,
      target."archivedAt",
      target.version;
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_count
  FROM public.users AS admin_users
  WHERE admin_users.role = 'ADMIN' AND admin_users.status = 'ACTIVE';
  IF active_count <= 1 THEN
    RAISE EXCEPTION 'Нельзя снять права последнего администратора' USING ERRCODE = 'P0001';
  END IF;

  restored := CASE
    WHEN target."roleBeforeAdmin" IN (
      'SGR_MANAGER'::public."UserRole",
      'RESPONSIBLE_ENGINEER'::public."UserRole",
      'CONTRACTOR_ENGINEER'::public."UserRole"
    ) THEN target."roleBeforeAdmin"
    ELSE 'PENDING_ROLE'::public."UserRole"
  END;

  PERFORM set_config('sgr.admin_grant', '1', true);
  UPDATE public.users
  SET
    role = restored,
    "roleBeforeAdmin" = NULL,
    "sessionVersion" = target."sessionVersion" + 1,
    version = target.version + 1,
    "updatedAt" = clock_timestamp()
  WHERE users.id = target_id;

  RETURN QUERY
  SELECT u.id, u."fullName", u.email, u.role, u."roleBeforeAdmin", u.status, u."archivedAt", u.version
  FROM public.users u
  WHERE u.id = target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_create_pending_user(
  p_full_name text,
  p_email text,
  p_password_hash text,
  p_actor_id uuid,
  p_actor_name text,
  p_request_id text
)
RETURNS TABLE (
  id uuid,
  full_name text,
  email text,
  "current_role" public."UserRole",
  status public."UserStatus",
  archived_at timestamptz,
  must_change_password boolean,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  last_login_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  created public.users%ROWTYPE;
BEGIN
  IF NOT public.sgr_is_super_admin() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_actor_id IS DISTINCT FROM public.sgr_ctx_user_id() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' OR p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION 'Некорректные данные' USING ERRCODE = '22023';
  END IF;
  IF p_password_hash IS NULL OR btrim(p_password_hash) = '' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.users (
    id,
    "fullName",
    email,
    role,
    status,
    "mustChangePassword",
    "sessionVersion",
    version,
    "createdAt",
    "updatedAt"
  ) VALUES (
    gen_random_uuid(),
    p_full_name,
    p_email,
    'PENDING_ROLE',
    'ACTIVE',
    true,
    1,
    1,
    clock_timestamp(),
    clock_timestamp()
  )
  RETURNING * INTO created;

  INSERT INTO public.user_credentials (
    "userId",
    "passwordHash",
    "passwordChangedAt",
    "createdAt",
    "updatedAt"
  ) VALUES (
    created.id,
    p_password_hash,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  );

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
    p_actor_id,
    p_actor_name,
    'USER_CREATED_PENDING_ROLE',
    'USER',
    created.id::text,
    NULL,
    jsonb_build_object(
      'fullName', created."fullName",
      'email', created.email,
      'role', 'PENDING_ROLE',
      'status', 'ACTIVE',
      'targetUserId', created.id
    ),
    'WEB',
    clock_timestamp(),
    p_request_id
  );

  RETURN QUERY
  SELECT
    created.id,
    created."fullName",
    created.email,
    created.role,
    created.status,
    created."archivedAt",
    created."mustChangePassword",
    created.version,
    created."createdAt",
    created."updatedAt",
    created."lastLoginAt";
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_create_pending_user(text, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_create_pending_user(text, text, text, uuid, text, text) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_insert_outbox_event(
  p_id uuid,
  p_type text,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT (
    pg_has_role(session_user, 'sgr_app', 'member')
    OR pg_has_role(session_user, 'sgr_worker', 'member')
    OR pg_has_role(session_user, 'sgr_owner', 'member')
  ) THEN
    RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
  END IF;
  IF pg_has_role(session_user, 'sgr_app', 'member')
    AND NOT pg_has_role(session_user, 'sgr_worker', 'member')
    AND NOT pg_has_role(session_user, 'sgr_owner', 'member')
    AND (
      public.sgr_is_super_admin()
      OR NOT public.sgr_is_business_user()
    ) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  new_id := coalesce(p_id, gen_random_uuid());
  INSERT INTO public.outbox_events (id, type, payload, status, "updatedAt")
  VALUES (new_id, p_type, p_payload, 'PENDING', clock_timestamp());
  RETURN new_id;
END;
$$;

DROP POLICY IF EXISTS users_app_select ON public.users;
CREATE POLICY users_app_select ON public.users FOR SELECT TO sgr_app
  USING (public.sgr_is_business_user() OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS org_select ON public.organizations;
CREATE POLICY org_select ON public.organizations FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS org_roles_select ON public.organization_role_assignments;
CREATE POLICY org_roles_select ON public.organization_role_assignments FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS org_wt_select ON public.organization_work_types;
CREATE POLICY org_wt_select ON public.organization_work_types FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS work_types_select ON public.work_types;
CREATE POLICY work_types_select ON public.work_types FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS defect_types_select ON public.defect_types;
CREATE POLICY defect_types_select ON public.defect_types FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS settings_select ON public.system_settings;
CREATE POLICY settings_select ON public.system_settings FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS objects_select ON public.property_objects;
CREATE POLICY objects_select ON public.property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_is_business_user()
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS poe_select ON public.property_object_engineers;
CREATE POLICY poe_select ON public.property_object_engineers FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object("propertyObjectId")
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS acts_select ON public.acts;
CREATE POLICY acts_select ON public.acts FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object("objectId")
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS defects_select ON public.defect_items;
CREATE POLICY defects_select ON public.defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS die_select ON public.defect_item_engineers;
CREATE POLICY die_select ON public.defect_item_engineers FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_defect_assigned("defectItemId")
    OR public.sgr_app_visible_object((
      SELECT a."objectId"
      FROM public.defect_items d
      JOIN public.acts a ON a.id = d."actId"
      WHERE d.id = "defectItemId"
    ))
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS dlo_select ON public.defect_item_liable_organizations;
CREATE POLICY dlo_select ON public.defect_item_liable_organizations FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified() AND (
        public.sgr_is_staff()
        OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        OR public.sgr_defect_assigned("defectItemId")
      )
    )
  );

DROP POLICY IF EXISTS proposals_select ON public.proposals;
CREATE POLICY proposals_select ON public.proposals FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified() AND (
        public.sgr_is_staff()
        OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        OR (public.sgr_is_responsible() AND slot = 'A' AND public.sgr_defect_assigned("defectItemId"))
      )
    )
  );

DROP POLICY IF EXISTS attachments_select ON public.attachments;
CREATE POLICY attachments_select ON public.attachments FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified() AND (
        ("actId" IS NOT NULL AND public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId")))
        OR ("defectItemId" IS NOT NULL AND (
          public.sgr_is_staff()
          OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
          OR public.sgr_defect_assigned("defectItemId")
        ))
        OR ("proposalId" IS NOT NULL AND (
          public.sgr_is_staff()
          OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
          OR (
            public.sgr_is_responsible()
            AND (SELECT p.slot FROM public.proposals p WHERE p.id = "proposalId") = 'A'
            AND public.sgr_defect_assigned((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = "proposalId"))
          )
        ))
      )
    )
  );

DROP POLICY IF EXISTS audit_select ON public.audit_logs;
CREATE POLICY audit_select ON public.audit_logs FOR SELECT TO sgr_app
  USING (
    public.sgr_ctx_verified() AND (
      public.sgr_is_staff()
      OR public.sgr_is_super_admin()
      OR (
        public.sgr_is_responsible()
        AND (
          ("entityType" = 'ACT' AND public.sgr_act_assigned(public.sgr_parse_uuid("entityId")))
          OR ("entityType" = 'DEFECT_ITEM' AND public.sgr_defect_assigned(public.sgr_parse_uuid("entityId")))
          OR ("parentEntityType" = 'ACT' AND public.sgr_act_assigned(public.sgr_parse_uuid("parentEntityId")))
          OR ("parentEntityType" = 'DEFECT_ITEM' AND public.sgr_defect_assigned(public.sgr_parse_uuid("parentEntityId")))
          OR ("entityType" = 'PROPERTY_OBJECT' AND public.sgr_object_assigned(public.sgr_parse_uuid("entityId")))
        )
        AND coalesce("newValue"->>'slot', "oldValue"->>'slot', '') NOT IN ('B', 'C')
      )
    )
  );

DROP POLICY IF EXISTS sla_select ON public.sla_clocks;
CREATE POLICY sla_select ON public.sla_clocks FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified() AND (
        public.sgr_is_staff()
        OR (public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER' AND kind = 'THIRD_PARTY')
        OR (public.sgr_is_responsible() AND kind = 'GENERAL' AND public.sgr_defect_assigned("defectItemId"))
      )
    )
  );

DROP POLICY IF EXISTS outbox_select_admin ON public.outbox_events;
CREATE POLICY outbox_select_admin ON public.outbox_events FOR SELECT TO sgr_app
  USING (public.sgr_is_admin() OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS ne_select ON public.notification_events;
CREATE POLICY ne_select ON public.notification_events FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND type = 'ACT_CHAT_MENTION'
      AND public.sgr_can_access_act_chat("actId")
    )
    OR (
      public.sgr_ctx_verified()
      AND type IS DISTINCT FROM 'ACT_CHAT_MENTION'
      AND (
        public.sgr_is_staff()
        OR (
          ("actId" IS NOT NULL AND public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId")))
          OR ("defectItemId" IS NOT NULL AND (
            public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER' OR public.sgr_defect_assigned("defectItemId")
          ))
        )
      )
    )
  );

DROP POLICY IF EXISTS nr_select ON public.notification_recipients;
CREATE POLICY nr_select ON public.notification_recipients FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_is_business_user() AND "userId" = public.sgr_ctx_user_id())
    OR public.sgr_is_staff()
  );

DROP POLICY IF EXISTS nr_update_app ON public.notification_recipients;
CREATE POLICY nr_update_app ON public.notification_recipients FOR UPDATE TO sgr_app
  USING (
    public.sgr_is_business_user() AND (
      "userId" = public.sgr_ctx_user_id() OR public.sgr_is_staff()
    )
  )
  WITH CHECK (
    public.sgr_is_business_user() AND (
      "userId" = public.sgr_ctx_user_id() OR public.sgr_is_staff()
    )
  );

DROP POLICY IF EXISTS email_select_admin ON public.email_deliveries;
CREATE POLICY email_select_admin ON public.email_deliveries FOR SELECT TO sgr_app
  USING (public.sgr_is_admin() OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS sla_state_select ON public.sla_evaluation_state;
CREATE POLICY sla_state_select ON public.sla_evaluation_state FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_is_admin() OR public.sgr_is_super_admin() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS acm_select ON public.act_chat_messages;
CREATE POLICY acm_select ON public.act_chat_messages FOR SELECT TO sgr_app
  USING (public.sgr_can_access_act_chat("actId") OR public.sgr_is_super_admin());

DROP POLICY IF EXISTS acn_select ON public.act_chat_mentions;
CREATE POLICY acn_select ON public.act_chat_mentions FOR SELECT TO sgr_app
  USING (
    public.sgr_is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.act_chat_messages m
      WHERE m.id = "messageId" AND public.sgr_can_access_act_chat(m."actId")
    )
  );

RESET ROLE;
