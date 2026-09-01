-- Guard user mutations for login role sgr_app_user (member of sgr_app), not only current_user = sgr_app.
SET ROLE sgr_owner;

CREATE OR REPLACE FUNCTION public.sgr_guard_user_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_has_role(current_user, 'sgr_app', 'member')
      AND NOT pg_has_role(current_user, 'sgr_owner', 'member')
      AND OLD.role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.role = 'ADMIN' AND NEW."roleBeforeAdmin" IS NULL THEN
    NEW."roleBeforeAdmin" := 'SGR_MANAGER';
  END IF;
  IF NEW.role IS DISTINCT FROM 'ADMIN' THEN
    NEW."roleBeforeAdmin" := NULL;
  END IF;

  IF pg_has_role(current_user, 'sgr_owner', 'member') THEN
    RETURN NEW;
  END IF;

  IF NOT pg_has_role(current_user, 'sgr_app', 'member') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role IN ('ADMIN', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPER_ADMIN' OR NEW.role = 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  IF current_setting('sgr.admin_grant', true) IS DISTINCT FROM '1' THEN
    IF OLD.role = 'ADMIN' AND (
      NEW.role IS DISTINCT FROM OLD.role
      OR NEW.status IS DISTINCT FROM OLD.status
    ) THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
    IF NEW.role = 'ADMIN' AND OLD.role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

RESET ROLE;
