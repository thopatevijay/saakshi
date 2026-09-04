DROP TABLE IF EXISTS onboarding_responses;
DROP TABLE IF EXISTS export_bundles;

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TABLE IF EXISTS audit_log;
DROP FUNCTION IF EXISTS audit_log_append_only();

-- The role must lose every dependent grant before it can be dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saakshi_app') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM saakshi_app';
    EXECUTE 'REVOKE ALL ON SCHEMA public FROM saakshi_app';
    EXECUTE 'DROP ROLE saakshi_app';
  END IF;
END
$$;
