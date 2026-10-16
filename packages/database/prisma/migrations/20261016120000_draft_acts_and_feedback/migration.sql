-- Draft acts can omit business fields. Object and defect-type names get
-- stable server-side sort keys. Creator of a NEW act keeps access when the
-- object is not chosen yet. Existing rows, memberships and assignments stay.

SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_alphabetical_sort_key(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(
    replace(
      replace(
        btrim(regexp_replace(normalize(coalesce(input, ''), NFKC), '[[:space:]]+', ' ', 'g')),
        'Ё',
        'Е'
      ),
      'ё',
      'е'
    )
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_natural_sort_key(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  source text;
  result text := '';
  i integer := 1;
  len integer;
  ch text;
  digits text;
BEGIN
  source := public.sgr_alphabetical_sort_key(input);
  len := char_length(source);
  WHILE i <= len LOOP
    ch := substr(source, i, 1);
    IF ch ~ '[0-9]' THEN
      digits := '';
      WHILE i <= len AND substr(source, i, 1) ~ '[0-9]' LOOP
        digits := digits || substr(source, i, 1);
        i := i + 1;
      END LOOP;
      result := result || lpad(left(digits, 12), 12, '0');
    ELSE
      result := result || ch;
      i := i + 1;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.sgr_alphabetical_sort_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sgr_natural_sort_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sgr_alphabetical_sort_key(text) TO sgr_app, sgr_worker, sgr_migrator;
GRANT EXECUTE ON FUNCTION public.sgr_natural_sort_key(text) TO sgr_app, sgr_worker, sgr_migrator;

ALTER TABLE public.property_objects
  ADD COLUMN "nameSortKey" text GENERATED ALWAYS AS (public.sgr_natural_sort_key(name)) STORED;

CREATE INDEX property_objects_name_sort_idx
  ON public.property_objects ("nameSortKey", id);

ALTER TABLE public.defect_types
  ADD COLUMN "nameSortKey" text GENERATED ALWAYS AS (public.sgr_alphabetical_sort_key(name)) STORED;

CREATE INDEX defect_types_name_sort_idx
  ON public.defect_types ("nameSortKey", id);

ALTER TABLE public.acts
  ALTER COLUMN "objectId" DROP NOT NULL,
  ALTER COLUMN "customerOrganizationId" DROP NOT NULL,
  ALTER COLUMN "issuedOn" DROP NOT NULL,
  ALTER COLUMN "formCode" DROP NOT NULL,
  ALTER COLUMN year DROP NOT NULL,
  ALTER COLUMN sequence DROP NOT NULL;

ALTER TABLE public.acts
  ADD COLUMN "createdById" uuid,
  ADD COLUMN "fillingEngineerId" uuid;

ALTER TABLE public.acts
  ADD CONSTRAINT acts_created_by_fkey
    FOREIGN KEY ("createdById") REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT acts_filling_engineer_fkey
    FOREIGN KEY ("fillingEngineerId") REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE INDEX acts_created_by_idx ON public.acts ("createdById");
CREATE INDEX acts_filling_engineer_idx ON public.acts ("fillingEngineerId");

ALTER TABLE public.defect_items
  ALTER COLUMN "defectTypeId" DROP NOT NULL;

ALTER TABLE public.property_object_engineers
  ADD COLUMN "revokedByUserId" uuid;

ALTER TABLE public.property_object_engineers
  ADD CONSTRAINT property_object_engineers_revoked_by_fkey
    FOREIGN KEY ("revokedByUserId") REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.sgr_act_assigned(act_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.acts a
    WHERE a.id = act_id
      AND (
        public.sgr_object_assigned(a."objectId")
        OR (
          a.status = 'NEW'
          AND a."createdById" IS NOT NULL
          AND a."createdById" = public.sgr_ctx_user_id()
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.sgr_defect_assigned(defect_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.defect_items d
    JOIN public.acts a ON a.id = d."actId"
    WHERE d.id = defect_id
      AND (
        public.sgr_object_assigned(a."objectId")
        OR (
          a.status = 'NEW'
          AND a."createdById" IS NOT NULL
          AND a."createdById" = public.sgr_ctx_user_id()
        )
      )
  )
$$;

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
  );

DROP POLICY IF EXISTS acts_insert ON public.acts;
CREATE POLICY acts_insert ON public.acts FOR INSERT TO sgr_app
  WITH CHECK (
    public.sgr_app_create_act()
    AND (
      public.sgr_is_staff()
      OR public.sgr_object_assigned("objectId")
      OR "objectId" IS NULL
    )
  );

DROP POLICY IF EXISTS acts_update ON public.acts;
CREATE POLICY acts_update ON public.acts FOR UPDATE TO sgr_app
  USING (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR (public.sgr_is_responsible() AND public.sgr_object_assigned("objectId"))
      OR (
        status = 'NEW'
        AND "createdById" IS NOT NULL
        AND "createdById" = public.sgr_ctx_user_id()
      )
    )
  )
  WITH CHECK (
    public.sgr_ctx_verified()
    AND (
      public.sgr_is_staff()
      OR (public.sgr_is_responsible() AND public.sgr_object_assigned("objectId"))
      OR (
        status = 'NEW'
        AND "createdById" IS NOT NULL
        AND "createdById" = public.sgr_ctx_user_id()
        AND ("objectId" IS NULL OR public.sgr_object_assigned("objectId"))
      )
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
  );
