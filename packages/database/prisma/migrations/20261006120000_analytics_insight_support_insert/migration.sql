-- Bulk support insert for a caller who already proved visibility.
-- sgr_owner has BYPASSRLS, so this function must repeat insight_defects_insert
-- itself. It does not grant a broader write than that policy.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_insert_insight_support(
  insight_id uuid,
  reason text,
  observed_at timestamptz,
  defect_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  scope_kind text;
  scope_fingerprint text;
  scope_user uuid;
  inserted integer := 0;
BEGIN
  IF insight_id IS NULL
    OR reason IS NULL
    OR observed_at IS NULL
    OR defect_ids IS NULL
    OR NOT public.sgr_ctx_verified() THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  SELECT insight."scopeKind"::text, insight."scopeFingerprint", insight."scopeUserId"
  INTO scope_kind, scope_fingerprint, scope_user
  FROM public.analytics_insights insight
  WHERE insight.id = insight_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF public.sgr_is_staff() AND scope_kind = 'COMPANY' THEN
    NULL;
  ELSIF public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND scope_kind = 'ORGANIZATION'
    AND scope_fingerprint = public.sgr_contractor_analytics_scope() THEN
    IF EXISTS (
      SELECT 1
      FROM unnest(defect_ids) AS defect_id
      WHERE NOT (
        public.sgr_contractor_can_see_defect(defect_id)
        OR public.sgr_defect_assigned(defect_id)
      )
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  ELSIF public.sgr_is_responsible()
    AND scope_kind = 'ASSIGNED'
    AND scope_user = public.sgr_ctx_user_id()
    AND scope_fingerprint = 'user:' || public.sgr_ctx_user_id()::text THEN
    IF EXISTS (
      SELECT 1
      FROM unnest(defect_ids) AS defect_id
      WHERE NOT (
        public.sgr_contractor_can_see_defect(defect_id)
        OR public.sgr_defect_assigned(defect_id)
      )
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.analytics_insight_defects (
    id, "insightId", "defectItemId", "contributionReason", "observedAt", "createdAt"
  )
  SELECT gen_random_uuid(), insight_id, defect_id, reason, observed_at, observed_at
  FROM unnest(defect_ids) AS defect_id;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

-- Invoker rights: link visibility stays under RLS. One indexed insightId scan,
-- stopping at the first support row that is in the caller's temp scope.
CREATE OR REPLACE FUNCTION public.sgr_insight_intersects_scope(target_insight uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  defect_id uuid;
BEGIN
  FOR defect_id IN
    SELECT link."defectItemId"
    FROM public.analytics_insight_defects link
    WHERE link."insightId" = target_insight
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_temp.analytics_scope_defects scope_row
      WHERE scope_row.id = defect_id
    ) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_insert_insight_support(uuid, text, timestamptz, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_insight_intersects_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_insert_insight_support(uuid, text, timestamptz, uuid[]) TO sgr_app;
GRANT EXECUTE ON FUNCTION public.sgr_insight_intersects_scope(uuid) TO sgr_app;

ALTER FUNCTION public.sgr_insert_insight_support(uuid, text, timestamptz, uuid[]) OWNER TO sgr_owner;
ALTER FUNCTION public.sgr_insight_intersects_scope(uuid) OWNER TO sgr_owner;

RESET ROLE;
