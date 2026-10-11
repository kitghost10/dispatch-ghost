-- Roles and request context, following LobbyStack's packages/db/migrations/0000_roles.sql
-- pattern (MIT): the runtime role never bypasses RLS, and every request sets
-- transaction-local context with set_config(..., true).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sb_app') THEN
    CREATE ROLE sb_app NOLOGIN;
  END IF;
END
$$;
-- Roles are created NOBYPASSRLS by default; refuse to continue if someone
-- granted the runtime role BYPASSRLS (only a superuser can change it).
DO $$
BEGIN
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'sb_app') THEN
    RAISE EXCEPTION 'sb_app must not have BYPASSRLS';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO sb_app;
GRANT USAGE ON SCHEMA public TO sb_app;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- 'tenant' (scoped to app.tenant_id), 'agency' (Sonic Bold staff: may list
-- tenants), 'auth' (login lookup only), or 'none'.
CREATE OR REPLACE FUNCTION app.current_actor() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor', true), ''), 'none')
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(), app.current_actor() TO sb_app;
