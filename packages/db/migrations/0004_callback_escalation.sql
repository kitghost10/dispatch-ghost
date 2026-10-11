-- Overdue urgent callbacks are re-alerted to on-call once (escalated_at).
ALTER TABLE callback_tasks ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

CREATE OR REPLACE FUNCTION app.overdue_urgent_callbacks(cutoff timestamptz) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT tenant_id, id FROM public.callback_tasks
  WHERE status = 'open' AND escalated_at IS NULL AND priority IN ('P0', 'P1') AND due_at <= cutoff
  ORDER BY due_at
  LIMIT 500
$$;
REVOKE ALL ON FUNCTION app.overdue_urgent_callbacks(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.overdue_urgent_callbacks(timestamptz) TO sb_app;
