-- Per-tenant row-level security for the runtime role (sb_app). The runtime must
-- never connect as the table owner (owners bypass RLS unless FORCEd; we rely on
-- that for the narrow SECURITY DEFINER lookups below). A missing WHERE tenant_id
-- in application code therefore cannot leak another tenant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'phone_numbers', 'calls', 'transcript_turns', 'call_events', 'bookings', 'sms_consent',
    'sms_conversations', 'sms_messages', 'missed_call_texts', 'callback_tasks', 'oncall_alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO sb_app', t);
  END LOOP;
END
$$;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sb_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_or_agency_read ON tenants FOR SELECT
  USING (id = app.current_tenant_id() OR app.current_actor() = 'agency');
CREATE POLICY tenant_update ON tenants FOR UPDATE
  USING (id = app.current_tenant_id() OR app.current_actor() = 'agency')
  WITH CHECK (id = app.current_tenant_id() OR app.current_actor() = 'agency');
CREATE POLICY agency_insert ON tenants FOR INSERT WITH CHECK (app.current_actor() = 'agency');
GRANT SELECT, INSERT, UPDATE ON tenants TO sb_app;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT
  USING (id = app.current_user_id() OR app.current_actor() IN ('agency', 'auth'));
CREATE POLICY users_agency_write ON users FOR INSERT WITH CHECK (app.current_actor() = 'agency');
GRANT SELECT, INSERT ON users TO sb_app;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_visible ON memberships FOR SELECT
  USING (user_id = app.current_user_id() OR tenant_id = app.current_tenant_id() OR app.current_actor() IN ('agency', 'auth'));
CREATE POLICY memberships_agency_write ON memberships FOR INSERT WITH CHECK (app.current_actor() = 'agency');
GRANT SELECT, INSERT ON memberships TO sb_app;

-- Inbound webhooks arrive before the tenant is known: resolve the dialled
-- number without granting cross-tenant reads.
CREATE OR REPLACE FUNCTION app.tenant_for_number(target text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT tenant_id FROM public.phone_numbers WHERE e164 = target
$$;
REVOKE ALL ON FUNCTION app.tenant_for_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_for_number(text) TO sb_app;

-- The worker scans for due callbacks across tenants; it only gets ids.
CREATE OR REPLACE FUNCTION app.due_callback_ids(cutoff timestamptz) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT tenant_id, id FROM public.callback_tasks WHERE status = 'open' AND due_at <= cutoff
$$;
REVOKE ALL ON FUNCTION app.due_callback_ids(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_callback_ids(timestamptz) TO sb_app;
