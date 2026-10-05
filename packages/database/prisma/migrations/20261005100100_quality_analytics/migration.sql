-- Quality analytics: inspection attempts, repair evidence, financial impact, insights.
SET ROLE sgr_owner;

CREATE TYPE public."InspectionAttemptStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
CREATE TYPE public."FinancialAmountType" AS ENUM (
  'ESTIMATE', 'APPROVED_AMOUNT', 'ACTUAL_COST', 'RECOVERY', 'AVOIDED_LOSS'
);
CREATE TYPE public."FinancialPayerType" AS ENUM (
  'COMPANY', 'LIABLE_ORGANIZATION', 'CUSTOMER', 'OTHER'
);
CREATE TYPE public."FinancialRecordStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'VOIDED');
CREATE TYPE public."AnalyticsInsightStatus" AS ENUM ('NEW', 'UNDER_REVIEW', 'CONFIRMED', 'DISMISSED');
CREATE TYPE public."AnalyticsScopeKind" AS ENUM ('COMPANY', 'ORGANIZATION', 'ASSIGNED');
CREATE TYPE public."WorkExposureType" AS ENUM ('AREA', 'COUNT', 'COST', 'OTHER');

GRANT USAGE ON TYPE public."InspectionAttemptStatus" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."FinancialAmountType" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."FinancialPayerType" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."FinancialRecordStatus" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."AnalyticsInsightStatus" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."AnalyticsScopeKind" TO sgr_app, sgr_worker;
GRANT USAGE ON TYPE public."WorkExposureType" TO sgr_app, sgr_worker;

CREATE TABLE public.defect_inspection_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "defectItemId" uuid NOT NULL REFERENCES public.defect_items(id) ON DELETE RESTRICT,
  "attemptNumber" integer NOT NULL,
  status public."InspectionAttemptStatus" NOT NULL,
  "submittedByUserId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "submittedAt" timestamptz(3) NOT NULL,
  "contractorComment" text,
  "reviewedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  "reviewedAt" timestamptz(3),
  "reviewComment" text,
  "rejectionReason" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT defect_inspection_attempts_number_positive CHECK ("attemptNumber" >= 1),
  CONSTRAINT defect_inspection_attempts_defect_number_unique UNIQUE ("defectItemId", "attemptNumber")
);

CREATE UNIQUE INDEX defect_inspection_attempts_one_pending_uidx
  ON public.defect_inspection_attempts ("defectItemId")
  WHERE status = 'PENDING';

CREATE INDEX defect_inspection_attempts_defect_status_idx
  ON public.defect_inspection_attempts ("defectItemId", status);

CREATE INDEX defect_inspection_attempts_submitted_idx
  ON public.defect_inspection_attempts ("submittedAt");

CREATE TABLE public.defect_financial_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "defectItemId" uuid NOT NULL REFERENCES public.defect_items(id) ON DELETE RESTRICT,
  "amountType" public."FinancialAmountType" NOT NULL,
  "payerType" public."FinancialPayerType" NOT NULL,
  "payerOrganizationId" uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  "amountOriginal" numeric(14, 2) NOT NULL,
  currency text NOT NULL,
  "exchangeRateToByn" numeric(18, 6) NOT NULL,
  "amountByn" numeric(14, 2) NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  status public."FinancialRecordStatus" NOT NULL,
  source text NOT NULL,
  comment text,
  "createdByUserId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "confirmedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  "confirmedAt" timestamptz(3),
  "voidedAt" timestamptz(3),
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT defect_financial_impacts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT defect_financial_impacts_byn_rate_check CHECK (
    (currency = 'BYN' AND "exchangeRateToByn" = 1) OR currency <> 'BYN'
  ),
  CONSTRAINT defect_financial_impacts_rate_positive CHECK ("exchangeRateToByn" > 0)
);

CREATE INDEX defect_financial_impacts_defect_idx
  ON public.defect_financial_impacts ("defectItemId", status, "amountType", "payerType");

CREATE INDEX defect_financial_impacts_occurred_idx
  ON public.defect_financial_impacts (status, "amountType", "payerType", "occurredAt");

CREATE TABLE public.analytics_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "signalKey" text NOT NULL,
  "signalType" text NOT NULL,
  title text NOT NULL,
  "plainLanguageExplanation" text NOT NULL,
  dimensions jsonb NOT NULL,
  "supportCount" integer NOT NULL,
  "totalCount" integer NOT NULL,
  "observedValue" numeric(18, 6) NOT NULL,
  "baselineValue" numeric(18, 6) NOT NULL,
  lift numeric(18, 6),
  confidence text NOT NULL,
  "sampleCoverage" numeric(8, 4),
  "periodFrom" timestamptz(3),
  "periodTo" timestamptz(3),
  "generatedAt" timestamptz(3) NOT NULL,
  "ruleVersion" text NOT NULL,
  status public."AnalyticsInsightStatus" NOT NULL DEFAULT 'NEW',
  "statisticallyStable" boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  "scopeKind" public."AnalyticsScopeKind" NOT NULL,
  "scopeFingerprint" text NOT NULL,
  "scopeOrganizationId" uuid,
  "scopeUserId" uuid,
  "reviewedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  "reviewedAt" timestamptz(3),
  "reviewComment" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT analytics_insights_key_scope_unique UNIQUE ("signalKey", "scopeFingerprint"),
  CONSTRAINT analytics_insights_support_check CHECK ("supportCount" >= 0 AND "totalCount" >= 0)
);

CREATE INDEX analytics_insights_scope_status_idx
  ON public.analytics_insights ("scopeKind", status, "generatedAt");

CREATE INDEX analytics_insights_fingerprint_active_idx
  ON public.analytics_insights ("scopeFingerprint", active);

CREATE TABLE public.work_exposures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  "propertyObjectId" uuid,
  "workTypeId" uuid,
  "exposureType" public."WorkExposureType" NOT NULL,
  "exposureValue" numeric(18, 4) NOT NULL,
  unit text NOT NULL,
  "periodFrom" timestamptz(3) NOT NULL,
  "periodTo" timestamptz(3) NOT NULL,
  source text NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX work_exposures_org_period_idx
  ON public.work_exposures ("organizationId", "periodFrom", "periodTo");

ALTER TABLE public.attachments
  ADD COLUMN "inspectionAttemptId" uuid REFERENCES public.defect_inspection_attempts(id) ON DELETE RESTRICT;

CREATE INDEX attachments_inspection_attempt_idx
  ON public.attachments ("inspectionAttemptId");

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_repair_evidence_owner_check CHECK (
    category <> 'REPAIR_EVIDENCE' OR "defectItemId" IS NOT NULL
  );

CREATE INDEX defect_items_created_at_idx ON public.defect_items ("createdAt");
CREATE INDEX defect_items_status_created_idx ON public.defect_items (status, "createdAt");

CREATE OR REPLACE FUNCTION public.sgr_guard_inspection_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inspection attempt cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('ACCEPTED', 'REJECTED') THEN
    RAISE EXCEPTION 'inspection attempt is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW."defectItemId" IS DISTINCT FROM OLD."defectItemId"
     OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
     OR NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId"
     OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'inspection attempt identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'PENDING' AND (
    NEW."reviewedAt" IS NOT NULL OR NEW."reviewedByUserId" IS NOT NULL OR NEW."rejectionReason" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pending inspection attempt cannot be reviewed in place' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER defect_inspection_attempts_guard
  BEFORE UPDATE OR DELETE ON public.defect_inspection_attempts
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_inspection_attempt();

CREATE OR REPLACE FUNCTION public.sgr_guard_financial_impact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financial impact cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('CONFIRMED', 'VOIDED') THEN
    RAISE EXCEPTION 'confirmed financial impact is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER defect_financial_impacts_guard
  BEFORE UPDATE OR DELETE ON public.defect_financial_impacts
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_financial_impact();

CREATE OR REPLACE FUNCTION public.sgr_guard_repair_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.category = 'REPAIR_EVIDENCE' AND OLD."inspectionAttemptId" IS NOT NULL THEN
      RAISE EXCEPTION 'repair evidence is immutable' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."inspectionAttemptId" IS NOT NULL THEN
    IF NEW."defectItemId" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.defect_inspection_attempts attempt
      WHERE attempt.id = NEW."inspectionAttemptId"
        AND attempt."defectItemId" = NEW."defectItemId"
    ) THEN
      RAISE EXCEPTION 'orphan repair evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD."inspectionAttemptId" IS NOT NULL AND OLD.category = 'REPAIR_EVIDENCE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'repair evidence is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD."inspectionAttemptId" IS NOT NULL
     AND NEW."inspectionAttemptId" IS DISTINCT FROM OLD."inspectionAttemptId" THEN
    RAISE EXCEPTION 'repair evidence cannot be reassigned' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attachments_repair_evidence_guard
  BEFORE UPDATE OR DELETE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_repair_evidence();

CREATE OR REPLACE FUNCTION public.sgr_guard_insight_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.sgr_is_staff() THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW."reviewedByUserId" IS DISTINCT FROM OLD."reviewedByUserId"
     OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
     OR NEW."reviewComment" IS DISTINCT FROM OLD."reviewComment" THEN
    RAISE EXCEPTION 'insight review is staff only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analytics_insights_review_guard
  BEFORE UPDATE ON public.analytics_insights
  FOR EACH ROW EXECUTE FUNCTION public.sgr_guard_insight_review();

CREATE OR REPLACE FUNCTION public.sgr_contractor_analytics_scope()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'org:' || coalesce(string_agg(m."organizationId"::text, ',' ORDER BY m."organizationId"), 'none')
  FROM public.user_organization_memberships m
  WHERE m."userId" = public.sgr_ctx_user_id()
    AND m."revokedAt" IS NULL
$$;

ALTER TABLE public.defect_inspection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.defect_inspection_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.defect_financial_impacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.defect_financial_impacts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_insights FORCE ROW LEVEL SECURITY;
ALTER TABLE public.work_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_exposures FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.defect_inspection_attempts TO sgr_app;
GRANT SELECT ON public.defect_inspection_attempts TO sgr_worker;
GRANT SELECT, INSERT, UPDATE ON public.defect_financial_impacts TO sgr_app;
GRANT SELECT ON public.defect_financial_impacts TO sgr_worker;
GRANT SELECT, INSERT, UPDATE ON public.analytics_insights TO sgr_app;
GRANT SELECT ON public.analytics_insights TO sgr_worker;
GRANT SELECT ON public.work_exposures TO sgr_app;
GRANT SELECT ON public.work_exposures TO sgr_worker;

CREATE POLICY attempts_select ON public.defect_inspection_attempts
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        public.sgr_is_staff()
        OR public.sgr_contractor_can_see_defect("defectItemId")
        OR public.sgr_defect_assigned("defectItemId")
      )
    )
  );

CREATE POLICY attempts_insert ON public.defect_inspection_attempts
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND status = 'PENDING'
    AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect("defectItemId")
    )
  );

CREATE POLICY attempts_update ON public.defect_inspection_attempts
  FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR (public.sgr_is_responsible() AND public.sgr_defect_assigned("defectItemId"))
    )
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR (public.sgr_is_responsible() AND public.sgr_defect_assigned("defectItemId"))
    )
  );

CREATE POLICY financial_select ON public.defect_financial_impacts
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
  );

CREATE POLICY financial_insert ON public.defect_financial_impacts
  FOR INSERT TO sgr_app
  WITH CHECK (public.sgr_ctx_verified() AND public.sgr_is_staff());

CREATE POLICY financial_update ON public.defect_financial_impacts
  FOR UPDATE TO sgr_app
  USING (public.sgr_ctx_verified() AND public.sgr_is_staff())
  WITH CHECK (public.sgr_ctx_verified() AND public.sgr_is_staff());

CREATE POLICY insights_select ON public.analytics_insights
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND public.sgr_is_staff()
      AND "scopeKind" = 'COMPANY'
    )
    OR (
      public.sgr_ctx_verified()
      AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
      AND "scopeKind" = 'ORGANIZATION'
      AND "scopeFingerprint" = public.sgr_contractor_analytics_scope()
    )
    OR (
      public.sgr_ctx_verified()
      AND public.sgr_is_responsible()
      AND "scopeKind" = 'ASSIGNED'
      AND "scopeUserId" = public.sgr_ctx_user_id()
    )
  );

CREATE POLICY insights_insert ON public.analytics_insights
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (
      (public.sgr_is_staff() AND "scopeKind" = 'COMPANY' AND "scopeFingerprint" = 'company')
      OR (
        public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        AND "scopeKind" = 'ORGANIZATION'
        AND "scopeFingerprint" = public.sgr_contractor_analytics_scope()
      )
      OR (
        public.sgr_is_responsible()
        AND "scopeKind" = 'ASSIGNED'
        AND "scopeUserId" = public.sgr_ctx_user_id()
        AND "scopeFingerprint" = 'user:' || public.sgr_ctx_user_id()::text
      )
    )
  );

CREATE POLICY insights_update ON public.analytics_insights
  FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (
      (public.sgr_is_staff() AND "scopeKind" = 'COMPANY')
      OR (
        public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        AND "scopeFingerprint" = public.sgr_contractor_analytics_scope()
      )
      OR (
        public.sgr_is_responsible()
        AND "scopeUserId" = public.sgr_ctx_user_id()
      )
    )
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (
      (public.sgr_is_staff() AND "scopeKind" = 'COMPANY')
      OR (
        public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
        AND "scopeFingerprint" = public.sgr_contractor_analytics_scope()
      )
      OR (
        public.sgr_is_responsible()
        AND "scopeUserId" = public.sgr_ctx_user_id()
      )
    )
  );

CREATE POLICY work_exposures_select ON public.work_exposures
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
  );

REVOKE ALL ON FUNCTION public.sgr_contractor_analytics_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_contractor_analytics_scope() TO sgr_app, sgr_worker;

RESET ROLE;
