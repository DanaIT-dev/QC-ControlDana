-- Contractor access is an explicit user↔organization membership, not a role-wide view.
SET ROLE sgr_owner;

CREATE TABLE public.user_organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "organizationId" uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  "assignedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  "assignedAt" timestamptz(3) NOT NULL DEFAULT now(),
  "revokedAt" timestamptz(3),
  "revokedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_organization_memberships_active_uidx
  ON public.user_organization_memberships ("userId", "organizationId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX user_organization_memberships_user_idx
  ON public.user_organization_memberships ("userId");

CREATE INDEX user_organization_memberships_org_active_idx
  ON public.user_organization_memberships ("organizationId")
  WHERE "revokedAt" IS NULL;

ALTER TABLE public.defect_items
  ADD COLUMN "submittedForInspectionAt" timestamptz(3),
  ADD COLUMN "submittedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN "submissionComment" text,
  ADD COLUMN "rejectedAt" timestamptz(3),
  ADD COLUMN "rejectedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN "rejectionReason" text,
  ADD COLUMN "acceptedAt" timestamptz(3),
  ADD COLUMN "acceptedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE public.user_organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_organization_memberships FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.user_organization_memberships TO sgr_app;
GRANT SELECT ON public.user_organization_memberships TO sgr_worker;

CREATE POLICY memberships_select ON public.user_organization_memberships
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        public.sgr_ctx_role() IN ('ADMIN', 'MANAGER')
        OR public.sgr_ctx_user_id() = "userId"
      )
    )
  );

CREATE POLICY memberships_insert ON public.user_organization_memberships
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER')
  );

CREATE POLICY memberships_update ON public.user_organization_memberships
  FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER')
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_ctx_role() IN ('ADMIN', 'MANAGER')
  );

CREATE OR REPLACE FUNCTION public.sgr_app_visible_object(oid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified() AND (
    public.sgr_is_staff()
    OR (public.sgr_is_responsible() AND public.sgr_object_assigned(oid))
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_defect(defect_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1
      FROM public.defect_item_liable_organizations dlo
      JOIN public.user_organization_memberships m
        ON m."organizationId" = dlo."organizationId"
       AND m."revokedAt" IS NULL
       AND m."userId" = public.sgr_ctx_user_id()
      WHERE dlo."defectItemId" = defect_id
    )
$$;

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_act(act_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = act_id
        AND a.status <> 'CANCELLED'
    )
    AND EXISTS (
      SELECT 1
      FROM public.defect_items d
      WHERE d."actId" = act_id
        AND public.sgr_contractor_can_see_defect(d.id)
    )
$$;

CREATE OR REPLACE FUNCTION public.sgr_contractor_can_see_object(oid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.sgr_ctx_verified()
    AND public.sgr_ctx_role() = 'CONTRACTOR_ENGINEER'
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a."objectId" = oid
        AND public.sgr_contractor_can_see_act(a.id)
    )
$$;

REVOKE ALL ON FUNCTION public.sgr_contractor_can_see_defect(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_contractor_can_see_act(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_contractor_can_see_object(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_contractor_can_see_defect(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_contractor_can_see_act(uuid) TO sgr_app, sgr_worker;
GRANT EXECUTE ON FUNCTION public.sgr_contractor_can_see_object(uuid) TO sgr_app, sgr_worker;

CREATE OR REPLACE FUNCTION public.sgr_attachment_visible(
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
    RETURN public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = p_act_id))
      OR public.sgr_contractor_can_see_act(p_act_id);
  END IF;
  IF p_defect_id IS NOT NULL THEN
    RETURN public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect(p_defect_id)
      OR public.sgr_defect_assigned(p_defect_id);
  END IF;
  IF p_proposal_id IS NOT NULL THEN
    RETURN public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = p_proposal_id))
      OR (
        public.sgr_is_responsible()
        AND (SELECT p.slot FROM public.proposals p WHERE p.id = p_proposal_id) = 'A'
        AND public.sgr_defect_assigned((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = p_proposal_id))
      );
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_can_write_sla_clock(p_defect_item_id uuid, p_kind "SlaClockKind")
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
    RETURN p_kind = 'THIRD_PARTY' AND public.sgr_contractor_can_see_defect(p_defect_item_id);
  END IF;
  IF public.sgr_is_responsible() THEN
    RETURN p_kind = 'GENERAL' AND public.sgr_defect_assigned(p_defect_item_id);
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.sgr_guard_contractor_defect_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.sgr_ctx_role() IS DISTINCT FROM 'CONTRACTOR_ENGINEER' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'IN_PROGRESS' AND NEW.status = 'PENDING_INSPECTION') THEN
    RAISE EXCEPTION 'contractor defect update rejected'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."actId" IS DISTINCT FROM OLD."actId"
    OR NEW.location IS DISTINCT FROM OLD.location
    OR NEW."defectTypeId" IS DISTINCT FROM OLD."defectTypeId"
    OR NEW."claimDetails" IS DISTINCT FROM OLD."claimDetails"
    OR NEW."plannedDeadline" IS DISTINCT FROM OLD."plannedDeadline"
    OR NEW."claimDeadline" IS DISTINCT FROM OLD."claimDeadline"
    OR NEW."readyAt" IS DISTINCT FROM OLD."readyAt"
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt"
    OR NEW."rejectedByUserId" IS DISTINCT FROM OLD."rejectedByUserId"
    OR NEW."rejectionReason" IS DISTINCT FROM OLD."rejectionReason"
    OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
    OR NEW."acceptedByUserId" IS DISTINCT FROM OLD."acceptedByUserId"
  THEN
    RAISE EXCEPTION 'contractor defect update rejected'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS objects_select ON public.property_objects;
CREATE POLICY objects_select ON public.property_objects FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object(id)
    OR public.sgr_contractor_can_see_object(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS acts_select ON public.acts;
CREATE POLICY acts_select ON public.acts FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object("objectId")
    OR public.sgr_contractor_can_see_act(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS defects_select ON public.defect_items;
CREATE POLICY defects_select ON public.defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
    OR public.sgr_contractor_can_see_defect(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );

DROP POLICY IF EXISTS defects_update ON public.defect_items;
CREATE POLICY defects_update ON public.defect_items FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified() AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect(id)
      OR (public.sgr_is_responsible() AND public.sgr_act_assigned("actId"))
    )
  )
  WITH CHECK (
    public.sgr_ctx_verified() AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect(id)
      OR (public.sgr_is_responsible() AND public.sgr_act_assigned("actId"))
    )
  );

DROP POLICY IF EXISTS dlo_select ON public.defect_item_liable_organizations;
CREATE POLICY dlo_select ON public.defect_item_liable_organizations FOR SELECT TO sgr_app, sgr_worker
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

DROP POLICY IF EXISTS proposals_select ON public.proposals;
CREATE POLICY proposals_select ON public.proposals FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        public.sgr_is_staff()
        OR public.sgr_contractor_can_see_defect("defectItemId")
        OR (
          public.sgr_is_responsible()
          AND slot = 'A'
          AND public.sgr_defect_assigned("defectItemId")
        )
      )
    )
  );

DROP POLICY IF EXISTS proposals_write ON public.proposals;
CREATE POLICY proposals_write ON public.proposals FOR ALL TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect("defectItemId")
    )
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR public.sgr_contractor_can_see_defect("defectItemId")
    )
  );

DROP POLICY IF EXISTS attachments_select ON public.attachments;
CREATE POLICY attachments_select ON public.attachments FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        ("actId" IS NOT NULL AND (
          public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
          OR public.sgr_contractor_can_see_act("actId")
        ))
        OR ("defectItemId" IS NOT NULL AND (
          public.sgr_is_staff()
          OR public.sgr_contractor_can_see_defect("defectItemId")
          OR public.sgr_defect_assigned("defectItemId")
        ))
        OR ("proposalId" IS NOT NULL AND (
          public.sgr_is_staff()
          OR public.sgr_contractor_can_see_defect((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = "proposalId"))
          OR (
            public.sgr_is_responsible()
            AND (SELECT p.slot FROM public.proposals p WHERE p.id = "proposalId") = 'A'
            AND public.sgr_defect_assigned((SELECT p."defectItemId" FROM public.proposals p WHERE p.id = "proposalId"))
          )
        ))
      )
    )
  );

DROP POLICY IF EXISTS sla_select ON public.sla_clocks;
CREATE POLICY sla_select ON public.sla_clocks FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        public.sgr_is_staff()
        OR (
          public.sgr_contractor_can_see_defect("defectItemId")
          AND kind = 'THIRD_PARTY'
        )
        OR (
          public.sgr_is_responsible()
          AND kind = 'GENERAL'
          AND public.sgr_defect_assigned("defectItemId")
        )
      )
    )
  );

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
          "actId" IS NOT NULL
          AND (
            public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
            OR public.sgr_contractor_can_see_act("actId")
          )
        )
        OR (
          "defectItemId" IS NOT NULL
          AND (
            public.sgr_contractor_can_see_defect("defectItemId")
            OR public.sgr_defect_assigned("defectItemId")
          )
        )
      )
    )
  );

RESET ROLE;
