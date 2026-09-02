-- startedAt / startedById, backfill existing acts, start-work definer, status sync.
SET ROLE sgr_owner;

ALTER TABLE public.acts
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "startedById" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'acts_startedById_fkey'
      AND conrelid = 'public.acts'::regclass
  ) THEN
    ALTER TABLE public.acts
      ADD CONSTRAINT "acts_startedById_fkey"
      FOREIGN KEY ("startedById") REFERENCES public.users(id)
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "acts_status_idx" ON public.acts ("status");

ALTER TABLE public.acts ALTER COLUMN status SET DEFAULT 'NEW';

-- Existing acts must keep IN_PROGRESS / COMPLETED / CANCELLED. Do not invent a starter.
UPDATE public.acts
SET "startedAt" = "createdAt"
WHERE "startedAt" IS NULL
  AND status IS DISTINCT FROM 'NEW';

ALTER TABLE public.acts
  DROP CONSTRAINT IF EXISTS acts_status_started_consistency;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_status_started_consistency CHECK (
    (
      status = 'NEW'
      AND "startedAt" IS NULL
      AND "cancelledAt" IS NULL
    )
    OR (
      status = 'IN_PROGRESS'
      AND "startedAt" IS NOT NULL
      AND "cancelledAt" IS NULL
    )
    OR (
      status = 'COMPLETED'
      AND "startedAt" IS NOT NULL
      AND "cancelledAt" IS NULL
    )
    OR status = 'CANCELLED'
  );

CREATE OR REPLACE FUNCTION public.sgr_start_act(
  p_act_id uuid,
  p_request_id text
)
RETURNS TABLE (
  id uuid,
  status text,
  started_at timestamptz,
  started_by_id uuid,
  started_by_name text,
  version integer,
  already_started boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  actor_id uuid;
  actor_role public."UserRole";
  actor_name text;
  actor_status public."UserStatus";
  locked public.acts%ROWTYPE;
  starter_name text;
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
    AND actor_role IS DISTINCT FROM 'SGR_MANAGER'
    AND actor_role IS DISTINCT FROM 'RESPONSIBLE_ENGINEER'
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
    jsonb_build_object('status', 'NEW'),
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

REVOKE ALL ON FUNCTION public.sgr_start_act(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_start_act(uuid, text) TO sgr_app;

CREATE OR REPLACE FUNCTION public.sgr_guard_act_started_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'sgr_app' AND NEW.status IS DISTINCT FROM 'CANCELLED' THEN
      NEW.status := 'NEW';
      NEW."startedAt" := NULL;
      NEW."startedById" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
    OR NEW."startedById" IS DISTINCT FROM OLD."startedById"
  THEN
    IF current_user IN ('sgr_app', 'sgr_auth', 'sgr_worker') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_guard_act_started_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_guard_act_started_fields() TO sgr_app;

DROP TRIGGER IF EXISTS trg_sgr_guard_act_started_fields ON public.acts;
CREATE TRIGGER trg_sgr_guard_act_started_fields
  BEFORE INSERT OR UPDATE ON public.acts
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_act_started_fields();

CREATE OR REPLACE FUNCTION public.sgr_guard_defect_complete_before_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED' THEN
    IF EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = NEW."actId"
        AND a."startedAt" IS NULL
        AND a.status = 'NEW'
    ) THEN
      RAISE EXCEPTION 'Нельзя исполнить дефект до начала работы по акту'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_guard_defect_complete_before_start() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_guard_defect_complete_before_start() TO sgr_app;

DROP TRIGGER IF EXISTS trg_sgr_guard_defect_complete_before_start ON public.defect_items;
CREATE TRIGGER trg_sgr_guard_defect_complete_before_start
  BEFORE UPDATE ON public.defect_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_guard_defect_complete_before_start();

CREATE OR REPLACE FUNCTION public.sgr_refresh_act_status_from_defects()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  act_row public.acts%ROWTYPE;
  next_status public."ActStatus";
  unfinished integer;
  active_count integer;
BEGIN
  SELECT a.*
  INTO act_row
  FROM public.acts a
  WHERE a.id = COALESCE(NEW."actId", OLD."actId");

  IF NOT FOUND OR act_row.status = 'CANCELLED' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF act_row."startedAt" IS NULL THEN
    next_status := 'NEW';
  ELSE
    SELECT
      count(*) FILTER (WHERE status = 'IN_PROGRESS'),
      count(*)
    INTO unfinished, active_count
    FROM public.defect_items
    WHERE "actId" = act_row.id;

    IF active_count > 0 AND unfinished = 0 THEN
      next_status := 'COMPLETED';
    ELSE
      next_status := 'IN_PROGRESS';
    END IF;
  END IF;

  IF act_row.status IS DISTINCT FROM next_status THEN
    UPDATE public.acts
    SET status = next_status, "updatedAt" = clock_timestamp()
    WHERE id = act_row.id
      AND status IS DISTINCT FROM 'CANCELLED';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_refresh_act_status_from_defects() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_refresh_act_status_from_defects() TO sgr_app;

DROP TRIGGER IF EXISTS trg_sgr_refresh_act_status_from_defects ON public.defect_items;
CREATE TRIGGER trg_sgr_refresh_act_status_from_defects
  AFTER INSERT OR UPDATE OF status, "actId" OR DELETE
  ON public.defect_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sgr_refresh_act_status_from_defects();

RESET ROLE;
