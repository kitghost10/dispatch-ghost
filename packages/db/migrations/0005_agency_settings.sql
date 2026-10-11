-- Shared operational defaults. Runtime access is through the agency actor.
CREATE TABLE agency_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agency_settings (id) VALUES (1);
ALTER TABLE agency_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY agency_settings_access ON agency_settings
  USING (app.current_actor() = 'agency')
  WITH CHECK (app.current_actor() = 'agency');
GRANT SELECT, INSERT, UPDATE ON agency_settings TO sb_app;
