-- sla_clocks writes must not exceed visibility. Runtime roles lose direct
-- INSERT/UPDATE/DELETE; mutations go through SECURITY DEFINER sgr_upsert_sla_clock.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_can_write_sla_clock(
  p_defect_item_id uuid,
  p_kind public."SlaClockKind"
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_defect_item_id IS NULL OR p_kind IS NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.defect_items d WHERE d.id = p_defect_item_id) THEN
    RETURN false;
  END IF;
  IF public.sgr_ctx_is_worker() THEN
    RETURN true;
  END IF;
  IF NOT public.sgr_is_business_user() THEN
    RETURN false;
  END IF;
  IF public.sgr_is_staff() THEN
    RETURN true;
  END IF;
  IF public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER' THEN
    RETURN p_kind = 'THIRD_PARTY';
  END IF;
  IF public.sgr_is_responsible() THEN
    RETURN p_kind = 'GENERAL' AND public.sgr_defect_assigned(p_defect_item_id);
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_upsert_sla_clock(
  p_id uuid,
  p_defect_item_id uuid,
  p_kind public."SlaClockKind",
  p_deadline timestamptz,
  p_cycle integer,
  p_state public."SlaClockState",
  p_satisfied_at timestamptz,
  p_version integer
)
RETURNS uuid
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
  ) THEN
    RAISE EXCEPTION 'RLS context rejected' USING ERRCODE = '28000';
  END IF;
  IF NOT public.sgr_can_write_sla_clock(p_defect_item_id, p_kind) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.sla_clocks (
    id,
    "defectItemId",
    kind,
    deadline,
    cycle,
    state,
    "satisfiedAt",
    version,
    "updatedAt"
  ) VALUES (
    coalesce(p_id, gen_random_uuid()),
    p_defect_item_id,
    p_kind,
    p_deadline,
    coalesce(p_cycle, 1),
    p_state,
    p_satisfied_at,
    greatest(coalesce(p_version, 1), 1),
    clock_timestamp()
  )
  ON CONFLICT ("defectItemId", kind)
  DO UPDATE SET
    deadline = EXCLUDED.deadline,
    cycle = EXCLUDED.cycle,
    state = EXCLUDED.state,
    "satisfiedAt" = EXCLUDED."satisfiedAt",
    version = public.sla_clocks.version + 1,
    "updatedAt" = clock_timestamp()
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_can_write_sla_clock(uuid, public."SlaClockKind") FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_upsert_sla_clock(
  uuid, uuid, public."SlaClockKind", timestamptz, integer, public."SlaClockState", timestamptz, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_can_write_sla_clock(uuid, public."SlaClockKind")
  TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_upsert_sla_clock(
  uuid, uuid, public."SlaClockKind", timestamptz, integer, public."SlaClockState", timestamptz, integer
) TO sgr_app, sgr_worker;

DROP POLICY IF EXISTS sla_write_app ON public.sla_clocks;
DROP POLICY IF EXISTS sla_write_worker ON public.sla_clocks;

CREATE POLICY sla_insert_app ON public.sla_clocks FOR INSERT TO sgr_app
  WITH CHECK (public.sgr_can_write_sla_clock("defectItemId", kind));
CREATE POLICY sla_update_app ON public.sla_clocks FOR UPDATE TO sgr_app
  USING (public.sgr_can_write_sla_clock("defectItemId", kind))
  WITH CHECK (public.sgr_can_write_sla_clock("defectItemId", kind));
CREATE POLICY sla_insert_worker ON public.sla_clocks FOR INSERT TO sgr_worker
  WITH CHECK (public.sgr_ctx_is_worker());
CREATE POLICY sla_update_worker ON public.sla_clocks FOR UPDATE TO sgr_worker
  USING (public.sgr_ctx_is_worker()) WITH CHECK (public.sgr_ctx_is_worker());

REVOKE INSERT, UPDATE, DELETE ON public.sla_clocks FROM sgr_app;
REVOKE INSERT, UPDATE, DELETE ON public.sla_clocks FROM sgr_worker;
GRANT SELECT ON public.sla_clocks TO sgr_app, sgr_worker;

RESET ROLE;
