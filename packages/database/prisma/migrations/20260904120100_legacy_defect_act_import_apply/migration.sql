-- Provenance tables, nullable imported fields, start/status guards for historical acts.
SET ROLE sgr_owner;

CREATE TABLE IF NOT EXISTS public.import_batches (
  id UUID PRIMARY KEY,
  "sourceSystem" TEXT NOT NULL,
  "sourceFileName" TEXT NOT NULL,
  "sourceFileSha256" TEXT NOT NULL,
  "sourceSheet" TEXT NOT NULL,
  environment TEXT NOT NULL,
  "databaseName" TEXT NOT NULL,
  status public."ImportBatchStatus" NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "createdActs" INTEGER NOT NULL DEFAULT 0,
  "createdDefects" INTEGER NOT NULL DEFAULT 0,
  "unchangedActs" INTEGER NOT NULL DEFAULT 0,
  "unchangedDefects" INTEGER NOT NULL DEFAULT 0,
  "createdOrganizations" INTEGER NOT NULL DEFAULT 0,
  "createdDefectTypes" INTEGER NOT NULL DEFAULT 0,
  stats JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "import_batches_sourceFileSha256_idx"
  ON public.import_batches ("sourceFileSha256");
CREATE INDEX IF NOT EXISTS "import_batches_sourceSystem_startedAt_idx"
  ON public.import_batches ("sourceSystem", "startedAt");

ALTER TABLE public.acts
  ALTER COLUMN "officialNumber" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "sourceSystem" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceFileName" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceFileSha256" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceSheet" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceRows" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN IF NOT EXISTS "sourceExternalUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceActNumberRaw" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceStatusRaw" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceImportKey" TEXT,
  ADD COLUMN IF NOT EXISTS "importedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "importBatchId" UUID;

ALTER TABLE public.defect_items
  ALTER COLUMN location DROP NOT NULL,
  ALTER COLUMN "claimDetails" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "sourceSystem" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceFileName" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceFileSha256" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceSheet" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceRows" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN IF NOT EXISTS "sourceDeadlineRaw" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceImportKey" TEXT,
  ADD COLUMN IF NOT EXISTS "importedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "importBatchId" UUID;

DROP INDEX IF EXISTS public."acts_officialNumber_key";

CREATE UNIQUE INDEX IF NOT EXISTS acts_official_number_live_unique
  ON public.acts ("officialNumber")
  WHERE "officialNumber" IS NOT NULL AND "importBatchId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS acts_source_import_key_unique
  ON public.acts ("sourceSystem", "sourceImportKey");

CREATE UNIQUE INDEX IF NOT EXISTS defect_items_source_import_key_unique
  ON public.defect_items ("sourceSystem", "sourceImportKey");

CREATE INDEX IF NOT EXISTS "acts_importBatchId_idx" ON public.acts ("importBatchId");
CREATE INDEX IF NOT EXISTS "defect_items_importBatchId_idx" ON public.defect_items ("importBatchId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'acts_importBatchId_fkey' AND conrelid = 'public.acts'::regclass
  ) THEN
    ALTER TABLE public.acts
      ADD CONSTRAINT "acts_importBatchId_fkey"
      FOREIGN KEY ("importBatchId") REFERENCES public.import_batches(id)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'defect_items_importBatchId_fkey' AND conrelid = 'public.defect_items'::regclass
  ) THEN
    ALTER TABLE public.defect_items
      ADD CONSTRAINT "defect_items_importBatchId_fkey"
      FOREIGN KEY ("importBatchId") REFERENCES public.import_batches(id)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE public.acts DROP CONSTRAINT IF EXISTS acts_imported_number_presence;
ALTER TABLE public.acts
  ADD CONSTRAINT acts_imported_number_presence CHECK (
    "officialNumber" IS NOT NULL OR "importBatchId" IS NOT NULL
  );

ALTER TABLE public.defect_items DROP CONSTRAINT IF EXISTS defect_items_imported_text_presence;
ALTER TABLE public.defect_items
  ADD CONSTRAINT defect_items_imported_text_presence CHECK (
    (
      location IS NOT NULL
      AND btrim(location) <> ''
      AND "claimDetails" IS NOT NULL
      AND btrim("claimDetails") <> ''
    )
    OR "importBatchId" IS NOT NULL
  );

ALTER TABLE public.acts DROP CONSTRAINT IF EXISTS acts_status_started_consistency;
ALTER TABLE public.acts
  ADD CONSTRAINT acts_status_started_consistency CHECK (
    (
      status = 'NEW'
      AND "startedAt" IS NULL
      AND "cancelledAt" IS NULL
    )
    OR (
      status = 'IMPORTED_UNSPECIFIED'
      AND "startedAt" IS NULL
      AND "cancelledAt" IS NULL
    )
    OR (
      status = 'IN_PROGRESS'
      AND "cancelledAt" IS NULL
      AND (
        "startedAt" IS NOT NULL
        OR "importBatchId" IS NOT NULL
      )
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

REVOKE ALL ON FUNCTION public.sgr_start_act(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_start_act(uuid, text) TO sgr_app;

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
    ) THEN
      RAISE EXCEPTION 'Нельзя исполнить дефект до начала работы по акту'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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
    IF act_row.status = 'IMPORTED_UNSPECIFIED' THEN
      next_status := 'IMPORTED_UNSPECIFIED';
    ELSIF act_row.status = 'IN_PROGRESS' AND act_row."importBatchId" IS NOT NULL THEN
      next_status := 'IN_PROGRESS';
    ELSE
      next_status := 'NEW';
    END IF;
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

ALTER TABLE public.import_batches OWNER TO sgr_owner;
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.import_batches FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;
GRANT SELECT ON TABLE public.import_batches TO sgr_app, sgr_worker;

DROP POLICY IF EXISTS import_batches_select ON public.import_batches;
CREATE POLICY import_batches_select ON public.import_batches FOR SELECT TO sgr_app, sgr_worker
  USING (public.sgr_ctx_verified() OR public.sgr_ctx_is_worker());

DROP POLICY IF EXISTS import_batches_insert ON public.import_batches;
CREATE POLICY import_batches_insert ON public.import_batches FOR INSERT TO sgr_app
  WITH CHECK (false);
DROP POLICY IF EXISTS import_batches_update ON public.import_batches;
CREATE POLICY import_batches_update ON public.import_batches FOR UPDATE TO sgr_app
  USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS import_batches_delete ON public.import_batches;
CREATE POLICY import_batches_delete ON public.import_batches FOR DELETE TO sgr_app
  USING (false);

RESET ROLE;
