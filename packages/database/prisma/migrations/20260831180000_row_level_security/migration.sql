-- Row-level security, FORCE RLS, HMAC request context, runtime grants.
-- Roles sgr_owner / sgr_app / sgr_auth / sgr_worker must already exist
-- (pnpm db:roles:provision). Secret rows are inserted by provision, not here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgr_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgr_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgr_auth')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sgr_worker') THEN
    RAISE EXCEPTION 'Database roles missing. Run pnpm db:roles:provision before this migration.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'pgcrypto missing. Run pnpm db:roles:provision before this migration.';
  END IF;
END
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO sgr_owner', r.relname);
  END LOOP;
END
$$;

ALTER SCHEMA public OWNER TO sgr_owner;

SET ROLE sgr_owner;

CREATE TABLE IF NOT EXISTS sgr_rls_secrets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

ALTER TABLE sgr_rls_secrets OWNER TO sgr_owner;
REVOKE ALL ON TABLE sgr_rls_secrets FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;

CREATE OR REPLACE FUNCTION sgr_active_rls_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT secret FROM public.sgr_rls_secrets
  WHERE revoked_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION sgr_fail_closed()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
END;
$$;

CREATE OR REPLACE FUNCTION sgr_verify_mac(body text, mac text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  secret text;
  expected text;
BEGIN
  secret := public.sgr_active_rls_secret();
  IF secret IS NULL OR mac IS NULL THEN
    RETURN false;
  END IF;
  expected := encode(public.hmac(body, secret, 'sha256'), 'hex');
  RETURN expected = lower(mac);
END;
$$;

CREATE OR REPLACE FUNCTION sgr_clear_request_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM set_config('sgr.verified', '', true);
  PERFORM set_config('sgr.kind', '', true);
  PERFORM set_config('sgr.uid', '', true);
  PERFORM set_config('sgr.role', '', true);
  PERFORM set_config('sgr.mac', '', true);
END;
$$;

CREATE OR REPLACE FUNCTION sgr_install_verified_guc(kind text, uid text, role_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  secret text;
  packed text;
BEGIN
  secret := public.sgr_active_rls_secret();
  IF secret IS NULL THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  packed := kind || ':' || coalesce(uid, '') || ':' || coalesce(role_name, '');
  PERFORM set_config('sgr.verified', '1', true);
  PERFORM set_config('sgr.kind', kind, true);
  PERFORM set_config('sgr.uid', coalesce(uid, ''), true);
  PERFORM set_config('sgr.role', coalesce(role_name, ''), true);
  PERFORM set_config('sgr.mac', encode(public.hmac(packed, secret, 'sha256'), 'hex'), true);
END;
$$;

CREATE OR REPLACE FUNCTION sgr_guc_intact()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  secret text;
  packed text;
  expected text;
  mac text;
BEGIN
  IF nullif(current_setting('sgr.verified', true), '') IS DISTINCT FROM '1' THEN
    RETURN false;
  END IF;
  secret := public.sgr_active_rls_secret();
  IF secret IS NULL THEN
    RETURN false;
  END IF;
  packed := coalesce(current_setting('sgr.kind', true), '')
    || ':' || coalesce(current_setting('sgr.uid', true), '')
    || ':' || coalesce(current_setting('sgr.role', true), '');
  expected := encode(public.hmac(packed, secret, 'sha256'), 'hex');
  mac := lower(coalesce(current_setting('sgr.mac', true), ''));
  RETURN expected = mac;
END;
$$;

CREATE OR REPLACE FUNCTION sgr_set_request_context(token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  sep int;
  body text;
  mac text;
  payload text;
  parts text[];
  user_id uuid;
  session_version int;
  issued_at bigint;
  nonce text;
  age_ms bigint;
  db_role public."UserRole";
  db_status public."UserStatus";
  db_session int;
BEGIN
  IF token IS NULL OR length(token) < 20 OR length(token) > 4096 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  sep := length(token) - position('.' IN reverse(token));
  IF sep <= 0 OR sep >= length(token) THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  body := left(token, sep);
  mac := substr(token, sep + 2);
  IF body NOT LIKE 'v1.%' THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  IF NOT public.sgr_verify_mac(body, mac) THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  payload := substr(body, 4);
  parts := string_to_array(payload, '|');
  IF array_length(parts, 1) IS DISTINCT FROM 5 OR parts[1] IS DISTINCT FROM 'user' THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  BEGIN
    user_id := parts[2]::uuid;
    session_version := parts[3]::int;
    issued_at := parts[4]::bigint;
    nonce := parts[5];
  EXCEPTION
    WHEN others THEN
      PERFORM public.sgr_fail_closed();
  END;
  IF nonce IS NULL OR length(nonce) < 8 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  age_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint - issued_at;
  IF age_ms < -5000 OR age_ms > 60000 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  SELECT u.role, u.status, u."sessionVersion"
    INTO db_role, db_status, db_session
  FROM public.users u
  WHERE u.id = user_id;
  IF db_role IS NULL OR db_status IS DISTINCT FROM 'ACTIVE' OR db_session IS DISTINCT FROM session_version THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  PERFORM public.sgr_install_verified_guc('user', user_id::text, db_role::text);
END;
$$;

CREATE OR REPLACE FUNCTION sgr_set_worker_context(token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  sep int;
  body text;
  mac text;
  payload text;
  parts text[];
  issued_at bigint;
  nonce text;
  age_ms bigint;
BEGIN
  IF token IS NULL OR length(token) < 16 OR length(token) > 4096 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  sep := length(token) - position('.' IN reverse(token));
  IF sep <= 0 OR sep >= length(token) THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  body := left(token, sep);
  mac := substr(token, sep + 2);
  IF body NOT LIKE 'v1.%' THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  IF NOT public.sgr_verify_mac(body, mac) THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  payload := substr(body, 4);
  parts := string_to_array(payload, '|');
  IF array_length(parts, 1) IS DISTINCT FROM 3 OR parts[1] IS DISTINCT FROM 'worker' THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  BEGIN
    issued_at := parts[2]::bigint;
    nonce := parts[3];
  EXCEPTION
    WHEN others THEN
      PERFORM public.sgr_fail_closed();
  END;
  IF nonce IS NULL OR length(nonce) < 8 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  age_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint - issued_at;
  IF age_ms < -5000 OR age_ms > 60000 THEN
    PERFORM public.sgr_fail_closed();
  END IF;
  PERFORM public.sgr_install_verified_guc('worker', '', 'WORKER');
END;
$$;

CREATE OR REPLACE FUNCTION sgr_ctx_verified()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_guc_intact() $$;

CREATE OR REPLACE FUNCTION sgr_ctx_is_worker()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_guc_intact() AND current_setting('sgr.kind', true) = 'worker' $$;

CREATE OR REPLACE FUNCTION sgr_ctx_user_id()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.sgr_guc_intact() OR current_setting('sgr.kind', true) IS DISTINCT FROM 'user' THEN
    RETURN NULL;
  END IF;
  RETURN nullif(current_setting('sgr.uid', true), '')::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION sgr_ctx_role()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.sgr_guc_intact() THEN
    RETURN NULL;
  END IF;
  RETURN nullif(current_setting('sgr.role', true), '');
END;
$$;

CREATE OR REPLACE FUNCTION sgr_is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_ctx_role() IN ('ADMIN', 'SGR_MANAGER') $$;

CREATE OR REPLACE FUNCTION sgr_is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_ctx_role() = 'ADMIN' $$;

CREATE OR REPLACE FUNCTION sgr_is_responsible()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_ctx_role() = 'RESPONSIBLE_ENGINEER' $$;

CREATE OR REPLACE FUNCTION sgr_object_assigned(oid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.property_object_engineers poe
    WHERE poe."propertyObjectId" = oid
      AND poe."userId" = public.sgr_ctx_user_id()
      AND poe."unassignedAt" IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION sgr_act_assigned(act_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.acts a
    WHERE a.id = act_id AND public.sgr_object_assigned(a."objectId")
  )
$$;

CREATE OR REPLACE FUNCTION sgr_defect_assigned(defect_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.defect_items d
    JOIN public.acts a ON a.id = d."actId"
    WHERE d.id = defect_id AND public.sgr_object_assigned(a."objectId")
  )
$$;

CREATE OR REPLACE FUNCTION sgr_app_visible_object(oid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND (
    public.sgr_is_staff()
    OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    OR (public.sgr_is_responsible() AND public.sgr_object_assigned(oid))
  )
$$;

CREATE OR REPLACE FUNCTION sgr_app_mutate_catalog()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.sgr_ctx_verified() AND public.sgr_is_staff() $$;

CREATE OR REPLACE FUNCTION sgr_app_create_act()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND public.sgr_ctx_role() IN (
    'ADMIN', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER'
  )
$$;

CREATE OR REPLACE FUNCTION sgr_parse_uuid(val text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF val IS NULL OR val !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  RETURN val::uuid;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION sgr_active_rls_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_fail_closed() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_verify_mac(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_clear_request_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_install_verified_guc(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_guc_intact() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_set_request_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_set_worker_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_ctx_verified() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_ctx_is_worker() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_ctx_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_ctx_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_is_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_is_responsible() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_object_assigned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_act_assigned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_defect_assigned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_app_visible_object(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_app_mutate_catalog() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_app_create_act() FROM PUBLIC;
REVOKE ALL ON FUNCTION sgr_parse_uuid(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION sgr_set_request_context(text) TO sgr_app;
GRANT EXECUTE ON FUNCTION sgr_set_worker_context(text) TO sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_clear_request_context() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_ctx_verified() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_ctx_is_worker() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_ctx_user_id() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_ctx_role() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_is_staff() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_is_admin() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_is_responsible() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_object_assigned(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_act_assigned(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_defect_assigned(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_app_visible_object(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_app_mutate_catalog() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_app_create_act() TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION sgr_parse_uuid(text) TO sgr_app, sgr_worker;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'property_objects', 'property_object_engineers', 'organizations',
    'organization_role_assignments', 'organization_work_types', 'work_types',
    'defect_types', 'acts', 'act_number_sequences', 'defect_items',
    'defect_item_engineers', 'defect_item_liable_organizations', 'proposals',
    'attachments', 'audit_logs', 'idempotency_records', 'system_settings',
    'sla_clocks', 'outbox_events', 'notification_events', 'notification_recipients',
    'email_deliveries', 'sla_evaluation_state', 'sgr_rls_secrets'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- users
CREATE POLICY users_app_select ON users FOR SELECT TO sgr_app
  USING (sgr_ctx_verified());
CREATE POLICY users_app_write ON users FOR ALL TO sgr_app
  USING (sgr_ctx_verified() AND sgr_is_admin())
  WITH CHECK (sgr_ctx_verified() AND sgr_is_admin());
CREATE POLICY users_auth_select ON users FOR SELECT TO sgr_auth USING (true);
CREATE POLICY users_auth_update ON users FOR UPDATE TO sgr_auth
  USING (true) WITH CHECK (true);
CREATE POLICY users_worker_select ON users FOR SELECT TO sgr_worker
  USING (sgr_ctx_is_worker());

-- catalogs
CREATE POLICY org_select ON organizations FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY org_write ON organizations FOR ALL TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY org_roles_select ON organization_role_assignments FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY org_roles_write ON organization_role_assignments FOR ALL TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY org_wt_select ON organization_work_types FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY org_wt_write ON organization_work_types FOR ALL TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY work_types_select ON work_types FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY work_types_write ON work_types FOR ALL TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY defect_types_select ON defect_types FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY defect_types_write ON defect_types FOR ALL TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());

-- property objects
CREATE POLICY objects_select ON property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_app_visible_object(id) OR sgr_ctx_is_worker());
CREATE POLICY objects_write ON property_objects FOR INSERT TO sgr_app
  WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY objects_update ON property_objects FOR UPDATE TO sgr_app
  USING (sgr_app_mutate_catalog()) WITH CHECK (sgr_app_mutate_catalog());
CREATE POLICY objects_delete ON property_objects FOR DELETE TO sgr_app
  USING (sgr_app_mutate_catalog());

CREATE POLICY poe_select ON property_object_engineers FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_app_visible_object("propertyObjectId") OR sgr_ctx_is_worker());
CREATE POLICY poe_write ON property_object_engineers FOR ALL TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_object_assigned("propertyObjectId"))
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_object_assigned("propertyObjectId"))
    )
  );

-- acts
CREATE POLICY acts_select ON acts FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_app_visible_object("objectId") OR sgr_ctx_is_worker());
CREATE POLICY acts_insert ON acts FOR INSERT TO sgr_app
  WITH CHECK (
    sgr_app_create_act() AND (
      sgr_is_staff() OR sgr_object_assigned("objectId")
    )
  );
CREATE POLICY acts_update ON acts FOR UPDATE TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_object_assigned("objectId"))
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_object_assigned("objectId"))
    )
  );
CREATE POLICY acts_delete ON acts FOR DELETE TO sgr_app
  USING (false);

CREATE POLICY seq_all ON act_number_sequences FOR ALL TO sgr_app
  USING (sgr_app_create_act()) WITH CHECK (sgr_app_create_act());

-- defect items
CREATE POLICY defects_select ON defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_app_visible_object((SELECT a."objectId" FROM acts a WHERE a.id = "actId")) OR sgr_ctx_is_worker());
CREATE POLICY defects_insert ON defect_items FOR INSERT TO sgr_app
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_act_assigned("actId"))
    )
  );
CREATE POLICY defects_update ON defect_items FOR UPDATE TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff()
      OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
      OR (sgr_is_responsible() AND sgr_act_assigned("actId"))
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff()
      OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
      OR (sgr_is_responsible() AND sgr_act_assigned("actId"))
    )
  );
CREATE POLICY defects_worker ON defect_items FOR UPDATE TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY die_select ON defect_item_engineers FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_defect_assigned("defectItemId") OR sgr_app_visible_object((
    SELECT a."objectId" FROM defect_items d JOIN acts a ON a.id = d."actId" WHERE d.id = "defectItemId"
  )) OR sgr_ctx_is_worker());
CREATE POLICY die_write ON defect_item_engineers FOR ALL TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_defect_assigned("defectItemId"))
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_defect_assigned("defectItemId"))
    )
  );

CREATE POLICY dlo_select ON defect_item_liable_organizations FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker() OR (
      sgr_ctx_verified() AND (
        sgr_is_staff() OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER' OR sgr_defect_assigned("defectItemId")
      )
    )
  );
CREATE POLICY dlo_write ON defect_item_liable_organizations FOR ALL TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_defect_assigned("defectItemId"))
    )
  )
  WITH CHECK (
    sgr_ctx_verified() AND (
      sgr_is_staff() OR (sgr_is_responsible() AND sgr_defect_assigned("defectItemId"))
    )
  );

-- proposals: B/C hidden from RESPONSIBLE at row level
CREATE POLICY proposals_select ON proposals FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker()
    OR (
      sgr_ctx_verified() AND (
        sgr_is_staff()
        OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        OR (sgr_is_responsible() AND slot = 'A' AND sgr_defect_assigned("defectItemId"))
      )
    )
  );
CREATE POLICY proposals_write ON proposals FOR ALL TO sgr_app
  USING (
    sgr_ctx_verified() AND sgr_ctx_role() IN ('ADMIN', 'SGR_MANAGER', 'CONTRACTOR_ENGINEER')
  )
  WITH CHECK (
    sgr_ctx_verified() AND sgr_ctx_role() IN ('ADMIN', 'SGR_MANAGER', 'CONTRACTOR_ENGINEER')
  );

-- attachments
CREATE POLICY attachments_select ON attachments FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker()
    OR (
      sgr_ctx_verified() AND (
        ("actId" IS NOT NULL AND sgr_app_visible_object((SELECT a."objectId" FROM acts a WHERE a.id = "actId")))
        OR ("defectItemId" IS NOT NULL AND (
          sgr_is_staff() OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER' OR sgr_defect_assigned("defectItemId")
        ))
        OR ("proposalId" IS NOT NULL AND (
          sgr_is_staff()
          OR sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
          OR (
            sgr_is_responsible()
            AND (SELECT p.slot FROM proposals p WHERE p.id = "proposalId") = 'A'
            AND sgr_defect_assigned((SELECT p."defectItemId" FROM proposals p WHERE p.id = "proposalId"))
          )
        ))
      )
    )
  );
CREATE POLICY attachments_write ON attachments FOR INSERT TO sgr_app
  WITH CHECK (sgr_ctx_verified());
CREATE POLICY attachments_update ON attachments FOR UPDATE TO sgr_app
  USING (sgr_ctx_verified()) WITH CHECK (sgr_ctx_verified());
CREATE POLICY attachments_delete ON attachments FOR DELETE TO sgr_app
  USING (sgr_ctx_verified());
CREATE POLICY attachments_worker ON attachments FOR UPDATE TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

-- audit: no SELECT for contractor; no UPDATE/DELETE for runtime
CREATE POLICY audit_select ON audit_logs FOR SELECT TO sgr_app
  USING (
    sgr_ctx_verified() AND (
      sgr_is_staff()
      OR (
        sgr_is_responsible()
        AND (
          ("entityType" = 'ACT' AND sgr_act_assigned(sgr_parse_uuid("entityId")))
          OR ("entityType" = 'DEFECT_ITEM' AND sgr_defect_assigned(sgr_parse_uuid("entityId")))
          OR ("parentEntityType" = 'ACT' AND sgr_act_assigned(sgr_parse_uuid("parentEntityId")))
          OR ("parentEntityType" = 'DEFECT_ITEM' AND sgr_defect_assigned(sgr_parse_uuid("parentEntityId")))
          OR ("entityType" = 'PROPERTY_OBJECT' AND sgr_object_assigned(sgr_parse_uuid("entityId")))
        )
        AND coalesce("newValue"->>'slot', "oldValue"->>'slot', '') NOT IN ('B', 'C')
      )
    )
  );
CREATE POLICY audit_insert_app ON audit_logs FOR INSERT TO sgr_app
  WITH CHECK (sgr_ctx_verified());
CREATE POLICY audit_insert_auth ON audit_logs FOR INSERT TO sgr_auth
  WITH CHECK (true);
CREATE POLICY audit_insert_worker ON audit_logs FOR INSERT TO sgr_worker
  WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY idem_all ON idempotency_records FOR ALL TO sgr_app
  USING (sgr_ctx_verified() AND "actorUserId" = sgr_ctx_user_id())
  WITH CHECK (sgr_ctx_verified() AND "actorUserId" = sgr_ctx_user_id());

CREATE POLICY settings_select ON system_settings FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_verified() OR sgr_ctx_is_worker());
CREATE POLICY settings_update_app ON system_settings FOR UPDATE TO sgr_app
  USING (sgr_is_admin()) WITH CHECK (sgr_is_admin());
CREATE POLICY settings_update_worker ON system_settings FOR UPDATE TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());
CREATE POLICY settings_insert ON system_settings FOR INSERT TO sgr_app, sgr_worker
  WITH CHECK (sgr_is_admin() OR sgr_ctx_is_worker());

CREATE POLICY sla_select ON sla_clocks FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker()
    OR (
      sgr_ctx_verified() AND (
        sgr_is_staff()
        OR (sgr_ctx_role() = 'CONTRACTOR_ENGINEER' AND kind = 'THIRD_PARTY')
        OR (sgr_is_responsible() AND kind = 'GENERAL' AND sgr_defect_assigned("defectItemId"))
      )
    )
  );
CREATE POLICY sla_write_app ON sla_clocks FOR ALL TO sgr_app
  USING (sgr_ctx_verified()) WITH CHECK (sgr_ctx_verified());
CREATE POLICY sla_write_worker ON sla_clocks FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY outbox_insert ON outbox_events FOR INSERT TO sgr_app
  WITH CHECK (sgr_ctx_verified());
CREATE POLICY outbox_select_admin ON outbox_events FOR SELECT TO sgr_app
  USING (sgr_is_admin());
CREATE POLICY outbox_worker ON outbox_events FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY ne_select ON notification_events FOR SELECT TO sgr_app, sgr_worker
  USING (
    sgr_ctx_is_worker()
    OR sgr_is_staff()
    OR (
      sgr_ctx_verified() AND (
        ("actId" IS NOT NULL AND sgr_app_visible_object((SELECT a."objectId" FROM acts a WHERE a.id = "actId")))
        OR ("defectItemId" IS NOT NULL AND (
          sgr_ctx_role() = 'CONTRACTOR_ENGINEER' OR sgr_defect_assigned("defectItemId")
        ))
      )
    )
  );
CREATE POLICY ne_worker ON notification_events FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY nr_select ON notification_recipients FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_ctx_is_worker() OR (sgr_ctx_verified() AND "userId" = sgr_ctx_user_id()) OR sgr_is_staff());
CREATE POLICY nr_update_app ON notification_recipients FOR UPDATE TO sgr_app
  USING (sgr_ctx_verified() AND "userId" = sgr_ctx_user_id())
  WITH CHECK (sgr_ctx_verified() AND "userId" = sgr_ctx_user_id());
CREATE POLICY nr_worker ON notification_recipients FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY email_select_admin ON email_deliveries FOR SELECT TO sgr_app
  USING (sgr_is_admin());
CREATE POLICY email_worker ON email_deliveries FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

CREATE POLICY sla_state_select ON sla_evaluation_state FOR SELECT TO sgr_app, sgr_worker
  USING (sgr_is_admin() OR sgr_ctx_is_worker());
CREATE POLICY sla_state_worker ON sla_evaluation_state FOR ALL TO sgr_worker
  USING (sgr_ctx_is_worker()) WITH CHECK (sgr_ctx_is_worker());

-- grants
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sgr_app, sgr_auth, sgr_worker;
GRANT USAGE ON SCHEMA public TO sgr_app, sgr_auth, sgr_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, property_objects, property_object_engineers, organizations,
  organization_role_assignments, organization_work_types, work_types, defect_types,
  acts, act_number_sequences, defect_items, defect_item_engineers,
  defect_item_liable_organizations, proposals, attachments, idempotency_records,
  system_settings, sla_clocks, notification_events, notification_recipients
TO sgr_app;
GRANT SELECT, INSERT ON audit_logs, outbox_events TO sgr_app;
GRANT SELECT ON email_deliveries, sla_evaluation_state TO sgr_app;

GRANT SELECT, UPDATE ON users TO sgr_auth;
GRANT INSERT ON audit_logs TO sgr_auth;

GRANT SELECT ON
  users, property_objects, property_object_engineers, organizations,
  organization_role_assignments, organization_work_types, work_types, defect_types,
  acts, defect_items, defect_item_engineers, defect_item_liable_organizations,
  proposals, attachments, sla_clocks, notification_events, notification_recipients,
  system_settings, sla_evaluation_state
TO sgr_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events, email_deliveries TO sgr_worker;
GRANT SELECT, INSERT, UPDATE ON notification_events, notification_recipients, sla_clocks, sla_evaluation_state, system_settings TO sgr_worker;
GRANT UPDATE ON attachments, defect_items TO sgr_worker;
GRANT INSERT ON audit_logs TO sgr_worker;

REVOKE ALL ON TABLE sgr_rls_secrets FROM sgr_app, sgr_auth, sgr_worker, PUBLIC;
REVOKE ALL ON TABLE _prisma_migrations FROM sgr_app, sgr_auth, sgr_worker, PUBLIC;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sgr_app, sgr_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sgr_auth;

RESET ROLE;
