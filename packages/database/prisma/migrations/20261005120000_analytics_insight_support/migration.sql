ALTER TABLE public.analytics_insights
  ADD COLUMN "filterSnapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "filterHash" text NOT NULL DEFAULT '',
  ADD COLUMN "snapshotHash" text,
  ADD COLUMN "supportAvailable" boolean NOT NULL DEFAULT false;

UPDATE public.analytics_insights
SET "snapshotHash" = 'legacy:' || id::text,
    "filterHash" = 'legacy',
    "supportAvailable" = false
WHERE "snapshotHash" IS NULL;

ALTER TABLE public.analytics_insights
  ALTER COLUMN "snapshotHash" SET NOT NULL;

ALTER TABLE public.analytics_insights
  DROP CONSTRAINT analytics_insights_key_scope_unique;

ALTER TABLE public.analytics_insights
  ADD CONSTRAINT analytics_insights_snapshot_scope_unique UNIQUE ("scopeFingerprint", "snapshotHash");

CREATE INDEX analytics_insights_signal_filter_active_idx
  ON public.analytics_insights ("signalKey", "scopeFingerprint", "filterHash", active);

CREATE TABLE public.analytics_insight_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "insightId" uuid NOT NULL REFERENCES public.analytics_insights(id) ON DELETE RESTRICT,
  "defectItemId" uuid NOT NULL REFERENCES public.defect_items(id) ON DELETE RESTRICT,
  "contributionReason" text NOT NULL,
  "observedAt" timestamptz(3) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT analytics_insight_defects_pair_unique UNIQUE ("insightId", "defectItemId")
);

CREATE INDEX analytics_insight_defects_defect_idx
  ON public.analytics_insight_defects ("defectItemId");

CREATE INDEX defect_items_open_created_idx
  ON public.defect_items (status, "createdAt")
  WHERE status <> 'COMPLETED';

CREATE OR REPLACE FUNCTION public.sgr_guard_insight_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."supportAvailable" AND (
    NEW."signalKey" IS DISTINCT FROM OLD."signalKey"
    OR NEW."signalType" IS DISTINCT FROM OLD."signalType"
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW."plainLanguageExplanation" IS DISTINCT FROM OLD."plainLanguageExplanation"
    OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
    OR NEW."supportCount" IS DISTINCT FROM OLD."supportCount"
    OR NEW."totalCount" IS DISTINCT FROM OLD."totalCount"
    OR NEW."observedValue" IS DISTINCT FROM OLD."observedValue"
    OR NEW."baselineValue" IS DISTINCT FROM OLD."baselineValue"
    OR NEW.lift IS DISTINCT FROM OLD.lift
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW."sampleCoverage" IS DISTINCT FROM OLD."sampleCoverage"
    OR NEW."periodFrom" IS DISTINCT FROM OLD."periodFrom"
    OR NEW."periodTo" IS DISTINCT FROM OLD."periodTo"
    OR NEW."generatedAt" IS DISTINCT FROM OLD."generatedAt"
    OR NEW."ruleVersion" IS DISTINCT FROM OLD."ruleVersion"
    OR NEW."statisticallyStable" IS DISTINCT FROM OLD."statisticallyStable"
    OR NEW."scopeKind" IS DISTINCT FROM OLD."scopeKind"
    OR NEW."scopeFingerprint" IS DISTINCT FROM OLD."scopeFingerprint"
    OR NEW."filterSnapshot" IS DISTINCT FROM OLD."filterSnapshot"
    OR NEW."filterHash" IS DISTINCT FROM OLD."filterHash"
    OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash"
    OR NEW."supportAvailable" IS DISTINCT FROM OLD."supportAvailable"
  ) THEN
    RAISE EXCEPTION 'published insight snapshot is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_insights_snapshot_guard
  BEFORE UPDATE ON public.analytics_insights
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_insight_snapshot();

CREATE OR REPLACE FUNCTION public.sgr_guard_insight_defect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user IN ('sgr_app', 'sgr_worker', 'sgr_auth') THEN
    RAISE EXCEPTION 'analytics support cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'analytics support is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER analytics_insight_defects_guard
  BEFORE UPDATE OR DELETE ON public.analytics_insight_defects
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_insight_defect();

ALTER TABLE public.analytics_insight_defects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_insight_defects FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.analytics_insight_defects TO sgr_app;
GRANT SELECT ON public.analytics_insight_defects TO sgr_worker;

CREATE POLICY insight_defects_select ON public.analytics_insight_defects
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR (
      EXISTS (
        SELECT 1 FROM public.analytics_insights insight
        WHERE insight.id = "insightId"
      )
      AND (
        public.sgr_is_super_admin()
        OR (
          public.sgr_ctx_verified()
          AND (
            public.sgr_is_staff()
            OR public.sgr_contractor_can_see_defect("defectItemId")
            OR public.sgr_defect_assigned("defectItemId")
          )
        )
      )
    )
  );

CREATE POLICY insight_defects_insert ON public.analytics_insight_defects
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND EXISTS (
      SELECT 1 FROM public.analytics_insights insight
      WHERE insight.id = "insightId"
    )
    AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect("defectItemId")
      OR public.sgr_defect_assigned("defectItemId")
    )
  );
