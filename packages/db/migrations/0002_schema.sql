CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding', 'active', 'paused')),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  e164 text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  provider_sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  is_agency_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_call_sid text,
  channel text NOT NULL DEFAULT 'voice' CHECK (channel IN ('voice', 'sms', 'simulator')),
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_sec integer,
  after_hours boolean NOT NULL DEFAULT false,
  priority text CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  issue text,
  outcome text,
  safety_flags text[] NOT NULL DEFAULT '{}',
  reason_codes text[] NOT NULL DEFAULT '{}',
  summary text,
  transfer_status text,
  recording_url text,
  missed boolean NOT NULL DEFAULT false,
  state jsonb,
  UNIQUE (tenant_id, provider_call_sid)
);
CREATE INDEX calls_tenant_started ON calls (tenant_id, started_at DESC);

CREATE TABLE transcript_turns (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('caller', 'agent', 'system')),
  text text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_call ON transcript_turns (call_id, id);

CREATE TABLE call_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_events_call ON call_events (call_id, id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  service_key text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  window_label text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  address text NOT NULL,
  zip text,
  problem text NOT NULL,
  sms_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed')),
  calendar_event_id text,
  fsm_provider text,
  fsm_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX bookings_tenant_time ON bookings (tenant_id, starts_at);

CREATE TABLE sms_consent (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('unknown', 'implied', 'granted', 'opted_out')),
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, phone)
);

CREATE TABLE sms_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone text NOT NULL,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  state jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);

CREATE TABLE sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES sms_conversations(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_e164 text NOT NULL,
  to_e164 text NOT NULL,
  body text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL,
  provider_sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_tenant_created ON sms_messages (tenant_id, created_at DESC);

CREATE TABLE missed_call_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'queued', 'skipped', 'failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE callback_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  priority text NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  reason text NOT NULL,
  caller_phone text NOT NULL,
  name text,
  notes text NOT NULL DEFAULT '',
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX callbacks_open ON callback_tasks (tenant_id, status, due_at);

CREATE TABLE oncall_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  priority text NOT NULL,
  reason text NOT NULL,
  recipients jsonb NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
