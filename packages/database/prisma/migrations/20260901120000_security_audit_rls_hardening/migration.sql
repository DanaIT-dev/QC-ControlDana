-- Tighten attachment writes to the SELECT visibility predicate and stop
-- CONTRACTOR_ENGINEER from changing non-deadline defect columns via SQL.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION sgr_attachment_visible(
  p_act_id uuid,
  p_defect_id uuid,
  p_proposal_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.sgr_ctx_verified() THEN
    RETURN false;
  END IF;
  IF p_act_id IS NOT NULL THEN
    RETURN public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = p_act_id));
  END IF;
  IF p_defect_id IS NOT NULL THEN
    RETURN public.sgr_is_staff()
      OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
      OR public.sgr_defect_assigned(p_defect_id);
  END IF;
  IF p_proposal_id IS NOT NULL THEN
    RETURN public.sgr_is_staff()
      OR public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
      OR (
        public.sgr_is_responsible()
        AND (SELECT p.slot FROM public.proposals p WHERE p.id = p_proposal_id) = 'A'
        AND public.sgr_defect_assigned((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = p_proposal_id))
      );
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION sgr_attachment_visible(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sgr_attachment_visible(uuid, uuid, uuid) TO sgr_app;

DROP POLICY IF EXISTS attachments_write ON attachments;
DROP POLICY IF EXISTS attachments_update ON attachments;
DROP POLICY IF EXISTS attachments_delete ON attachments;

CREATE POLICY attachments_write ON attachments FOR INSERT TO sgr_app
  WITH CHECK (sgr_attachment_visible("actId", "defectItemId", "proposalId"));
CREATE POLICY attachments_update ON attachments FOR UPDATE TO sgr_app
  USING (sgr_attachment_visible("actId", "defectItemId", "proposalId"))
  WITH CHECK (sgr_attachment_visible("actId", "defectItemId", "proposalId"));
CREATE POLICY attachments_delete ON attachments FOR DELETE TO sgr_app
  USING (sgr_attachment_visible("actId", "defectItemId", "proposalId"));

CREATE OR REPLACE FUNCTION sgr_guard_contractor_defect_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.sgr_ctx_role() IS DISTINCT FROM 'CONTRACTOR_ENGINEER' THEN
    RETURN NEW;
  END IF;
  IF NEW."actId" IS DISTINCT FROM OLD."actId"
    OR NEW.location IS DISTINCT FROM OLD.location
    OR NEW."defectTypeId" IS DISTINCT FROM OLD."defectTypeId"
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW."claimDetails" IS DISTINCT FROM OLD."claimDetails"
    OR NEW."plannedDeadline" IS DISTINCT FROM OLD."plannedDeadline"
    OR NEW."claimDeadline" IS DISTINCT FROM OLD."claimDeadline"
    OR NEW."readyAt" IS DISTINCT FROM OLD."readyAt"
    OR NEW.notes IS DISTINCT FROM OLD.notes
  THEN
    RAISE EXCEPTION 'contractor defect update rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION sgr_guard_contractor_defect_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sgr_guard_contractor_defect_update() TO sgr_app;

DROP TRIGGER IF EXISTS trg_sgr_guard_contractor_defect_update ON defect_items;
CREATE TRIGGER trg_sgr_guard_contractor_defect_update
  BEFORE UPDATE ON defect_items
  FOR EACH ROW
  EXECUTE FUNCTION sgr_guard_contractor_defect_update();

RESET ROLE;
