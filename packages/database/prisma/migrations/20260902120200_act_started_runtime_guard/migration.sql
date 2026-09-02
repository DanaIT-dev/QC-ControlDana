-- Runtime login roles are sgr_app_user / sgr_auth_user / sgr_worker_user,
-- members of sgr_app / sgr_auth / sgr_worker — not the group names themselves.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_guard_act_started_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  runtime boolean;
BEGIN
  runtime := current_setting('is_superuser', true) = 'off'
    AND NOT pg_has_role(current_user, 'sgr_owner', 'MEMBER');

  IF TG_OP = 'INSERT' THEN
    IF runtime AND NEW.status IS DISTINCT FROM 'CANCELLED' THEN
      NEW.status := 'NEW';
      NEW."startedAt" := NULL;
      NEW."startedById" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
    OR NEW."startedById" IS DISTINCT FROM OLD."startedById"
  THEN
    IF runtime THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

RESET ROLE;
