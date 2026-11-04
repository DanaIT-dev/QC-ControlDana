-- Approval request for closing an act without inspection.
-- The author of an act keeps read access to that act after leaving the object,
-- so they can ask for approval. This does not grant update, registry-wide access,
-- attachments, or analytics.
SET ROLE sgr_owner;

CREATE TYPE public."ActClosureRequestStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'OBSOLETE'
);

CREATE TABLE public.act_closure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actId" uuid NOT NULL REFERENCES public.acts(id) ON DELETE RESTRICT,
  status public."ActClosureRequestStatus" NOT NULL,
  reason text NOT NULL,
  "requestedByUserId" uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "requestedByName" text NOT NULL,
  "requestedAt" timestamptz(3) NOT NULL,
  "decidedByUserId" uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  "decidedByName" text,
  "decidedAt" timestamptz(3),
  "decisionReason" text,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT act_closure_requests_reason_present CHECK (length(btrim(reason)) > 0),
  CONSTRAINT act_closure_requests_name_present CHECK (length(btrim("requestedByName")) > 0),
  CONSTRAINT act_closure_requests_not_self_decision CHECK (
    "decidedByUserId" IS NULL OR "decidedByUserId" <> "requestedByUserId"
  ),
  CONSTRAINT act_closure_requests_status_shape CHECK (
    (
      status = 'PENDING'
      AND "decidedByUserId" IS NULL
      AND "decidedByName" IS NULL
      AND "decidedAt" IS NULL
      AND "decisionReason" IS NULL
    )
    OR (
      status = 'APPROVED'
      AND "decidedByUserId" IS NOT NULL
      AND length(btrim("decidedByName")) > 0
      AND "decidedAt" IS NOT NULL
      AND "decisionReason" IS NULL
    )
    OR (
      status = 'REJECTED'
      AND "decidedByUserId" IS NOT NULL
      AND length(btrim("decidedByName")) > 0
      AND "decidedAt" IS NOT NULL
      AND length(btrim("decisionReason")) > 0
    )
    OR (
      status = 'OBSOLETE'
      AND "decidedByUserId" IS NULL
      AND "decidedByName" IS NULL
      AND "decidedAt" IS NULL
      AND "decisionReason" IS NULL
    )
  )
);

CREATE UNIQUE INDEX act_closure_requests_one_pending
  ON public.act_closure_requests ("actId")
  WHERE status = 'PENDING';

CREATE INDEX act_closure_requests_act_requested_idx
  ON public.act_closure_requests ("actId", "requestedAt");

CREATE INDEX act_closure_requests_requested_by_idx
  ON public.act_closure_requests ("requestedByUserId");

CREATE INDEX act_closure_requests_decided_by_idx
  ON public.act_closure_requests ("decidedByUserId");

CREATE OR REPLACE FUNCTION public.sgr_can_decide_act_closure(p_act_id uuid, p_initiator_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor uuid;
  actor_role text;
  object_id uuid;
  engineer_count integer;
BEGIN
  IF NOT public.sgr_ctx_verified() THEN
    RETURN false;
  END IF;
  actor := public.sgr_ctx_user_id();
  IF actor IS NULL OR actor = p_initiator_id THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = actor AND u.status = 'ACTIVE'
  ) THEN
    RETURN false;
  END IF;
  actor_role := public.sgr_ctx_role();
  IF actor_role = 'SUPER_ADMIN' THEN
    RETURN true;
  END IF;
  IF actor_role NOT IN ('ADMIN', 'SGR_MANAGER', 'RESPONSIBLE_ENGINEER') THEN
    RETURN false;
  END IF;
  SELECT a."objectId" INTO object_id FROM public.acts a WHERE a.id = p_act_id;
  IF object_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT count(*)::integer INTO engineer_count
  FROM public.property_object_engineers poe
  JOIN public.users u ON u.id = poe."userId"
  WHERE poe."propertyObjectId" = object_id
    AND poe."unassignedAt" IS NULL
    AND u.status = 'ACTIVE'
    AND u.role = 'RESPONSIBLE_ENGINEER';
  IF engineer_count > 0 THEN
    RETURN actor_role = 'RESPONSIBLE_ENGINEER'
      AND EXISTS (
        SELECT 1
        FROM public.property_object_engineers poe
        JOIN public.users u ON u.id = poe."userId"
        WHERE poe."propertyObjectId" = object_id
          AND poe."userId" = actor
          AND poe."unassignedAt" IS NULL
          AND u.status = 'ACTIVE'
          AND u.role = 'RESPONSIBLE_ENGINEER'
      );
  END IF;
  RETURN actor_role IN ('ADMIN', 'SGR_MANAGER');
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_can_decide_act_closure(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_can_decide_act_closure(uuid, uuid) TO sgr_app;

ALTER TABLE public.act_closure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.act_closure_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.act_closure_requests FROM PUBLIC, sgr_app, sgr_auth, sgr_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE public.act_closure_requests TO sgr_app;

CREATE POLICY act_closure_requests_select
  ON public.act_closure_requests
  FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (
      public.sgr_ctx_verified()
      AND (
        public.sgr_is_staff()
        OR (
          public.sgr_is_responsible()
          AND EXISTS (
            SELECT 1
            FROM public.acts a
            WHERE a.id = "actId"
              AND (
                public.sgr_object_assigned(a."objectId")
                OR (
                  a."createdById" IS NOT NULL
                  AND a."createdById" = public.sgr_ctx_user_id()
                )
              )
          )
        )
      )
    )
  );

CREATE POLICY act_closure_requests_insert
  ON public.act_closure_requests
  FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_ctx_verified()
    AND public.sgr_is_responsible()
    AND status = 'PENDING'
    AND "requestedByUserId" = public.sgr_ctx_user_id()
    AND EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = "actId"
        AND a."objectId" IS NOT NULL
        AND a.status = 'IN_PROGRESS'
        AND a."startedAt" IS NOT NULL
        AND a."closureMethod" IS NULL
        AND a."createdById" = public.sgr_ctx_user_id()
        AND NOT public.sgr_object_assigned(a."objectId")
        AND EXISTS (SELECT 1 FROM public.defect_items d WHERE d."actId" = a.id)
    )
  );

CREATE POLICY act_closure_requests_update
  ON public.act_closure_requests
  FOR UPDATE TO sgr_app
  USING (
    status = 'PENDING'
    AND public.sgr_ctx_verified()
    AND (
      public.sgr_can_decide_act_closure("actId", "requestedByUserId")
      OR public.sgr_is_staff()
      OR public.sgr_is_super_admin()
      OR (
        public.sgr_is_responsible()
        AND public.sgr_object_assigned((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
      )
    )
  )
  WITH CHECK (
    (
      status IN ('APPROVED', 'REJECTED')
      AND public.sgr_can_decide_act_closure("actId", "requestedByUserId")
      AND "decidedByUserId" = public.sgr_ctx_user_id()
      AND "decidedAt" IS NOT NULL
      AND length(btrim("decidedByName")) > 0
      AND (
        (status = 'APPROVED' AND "decisionReason" IS NULL)
        OR (status = 'REJECTED' AND length(btrim("decisionReason")) > 0)
      )
    )
    OR (
      status = 'OBSOLETE'
      AND "decidedByUserId" IS NULL
      AND "decidedByName" IS NULL
      AND "decidedAt" IS NULL
      AND "decisionReason" IS NULL
      AND (
        public.sgr_is_staff()
        OR public.sgr_is_super_admin()
        OR (
          public.sgr_is_responsible()
          AND public.sgr_object_assigned((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
        )
      )
    )
  );

CREATE POLICY act_closure_requests_delete
  ON public.act_closure_requests
  FOR DELETE TO sgr_app
  USING (false);

DROP POLICY IF EXISTS acts_select ON public.acts;
CREATE POLICY acts_select ON public.acts FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
    OR public.sgr_app_visible_object("objectId")
    OR public.sgr_contractor_can_see_act(id)
    OR (
      status = 'NEW'
      AND "createdById" IS NOT NULL
      AND "createdById" = public.sgr_ctx_user_id()
    )
    OR (
      public.sgr_is_responsible()
      AND "createdById" IS NOT NULL
      AND "createdById" = public.sgr_ctx_user_id()
    )
  );

DROP POLICY IF EXISTS defects_select ON public.defect_items;
CREATE POLICY defects_select ON public.defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_ctx_is_worker()
    OR public.sgr_is_super_admin()
    OR (public.sgr_ctx_verified() AND public.sgr_is_staff())
    OR public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
    OR public.sgr_contractor_can_see_defect(id)
    OR EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = "actId"
        AND a.status = 'NEW'
        AND a."createdById" IS NOT NULL
        AND a."createdById" = public.sgr_ctx_user_id()
    )
    OR EXISTS (
      SELECT 1
      FROM public.acts a
      WHERE a.id = "actId"
        AND public.sgr_is_responsible()
        AND a."createdById" IS NOT NULL
        AND a."createdById" = public.sgr_ctx_user_id()
    )
  );

RESET ROLE;
