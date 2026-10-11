/**
 * Postgres Store. Every tenant-scoped call runs inside a transaction that sets
 * app.tenant_id / app.actor via set_config(..., true), so RLS policies
 * (migrations/0003_rls.sql) confine it to one tenant even if a query forgets
 * its WHERE clause. Connect as the non-owner runtime role (sb_app).
 */
import pg from "pg";
import { applyAgencySettings, agencySettingsSchema, parseTenantConfig, type AgencySettings, type ConsentStatus, type TenantConfig } from "@sb/core";
import type {
  BookingRecord,
  CallEvent,
  CallPatch,
  CallRecord,
  CallbackTask,
  DashboardStats,
  Membership,
  MissedCallText,
  NewBooking,
  OnCallAlertRecord,
  SmsConversation,
  SmsMessage,
  Store,
  Tenant,
  TranscriptTurn,
  User,
} from "./types";

type Ctx = { tenantId?: string; userId?: string; actor: "tenant" | "agency" | "auth" | "none" };
type Q = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;

const ts = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const tsOrNull = (v: unknown): string | null => (v == null ? null : ts(v));

function toTenant(r: Record<string, unknown>): Tenant {
  return { id: String(r.id), slug: String(r.slug), name: String(r.name), status: r.status as Tenant["status"], config: parseTenantConfig(r.config), createdAt: ts(r.created_at) };
}
function toCall(r: Record<string, unknown>): CallRecord {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), providerCallSid: (r.provider_call_sid as string | null) ?? null, channel: r.channel as CallRecord["channel"],
    fromE164: String(r.from_e164), toE164: String(r.to_e164), status: String(r.status), startedAt: ts(r.started_at), endedAt: tsOrNull(r.ended_at),
    durationSec: (r.duration_sec as number | null) ?? null, afterHours: Boolean(r.after_hours), priority: (r.priority as CallRecord["priority"]) ?? null,
    issue: (r.issue as string | null) ?? null, outcome: (r.outcome as string | null) ?? null, safetyFlags: (r.safety_flags as string[]) ?? [],
    reasonCodes: (r.reason_codes as string[]) ?? [], summary: (r.summary as string | null) ?? null, transferStatus: (r.transfer_status as string | null) ?? null,
    recordingUrl: (r.recording_url as string | null) ?? null, missed: Boolean(r.missed), state: r.state ?? null,
  };
}
function toBooking(r: Record<string, unknown>): BookingRecord {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), callId: (r.call_id as string | null) ?? null, serviceKey: String(r.service_key), priority: r.priority as BookingRecord["priority"],
    startsAt: ts(r.starts_at), endsAt: ts(r.ends_at), windowLabel: String(r.window_label), customerName: String(r.customer_name), customerPhone: String(r.customer_phone),
    address: String(r.address), zip: (r.zip as string | null) ?? null, problem: String(r.problem), smsConsent: Boolean(r.sms_consent), status: r.status as BookingRecord["status"],
    calendarEventId: (r.calendar_event_id as string | null) ?? null, fsmProvider: (r.fsm_provider as string | null) ?? null, fsmRef: (r.fsm_ref as string | null) ?? null, createdAt: ts(r.created_at),
  };
}
function toSms(r: Record<string, unknown>): SmsMessage {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), conversationId: (r.conversation_id as string | null) ?? null, direction: r.direction as SmsMessage["direction"],
    fromE164: String(r.from_e164), toE164: String(r.to_e164), body: String(r.body), purpose: String(r.purpose), status: String(r.status), providerSid: (r.provider_sid as string | null) ?? null, createdAt: ts(r.created_at),
  };
}
function toCallback(r: Record<string, unknown>): CallbackTask {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), callId: (r.call_id as string | null) ?? null, priority: r.priority as CallbackTask["priority"], reason: String(r.reason),
    callerPhone: String(r.caller_phone), name: (r.name as string | null) ?? null, notes: String(r.notes), dueAt: ts(r.due_at), status: r.status as CallbackTask["status"],
    createdAt: ts(r.created_at), completedAt: tsOrNull(r.completed_at), escalatedAt: tsOrNull(r.escalated_at),
  };
}

const CALL_COLUMNS: Record<keyof CallPatch, string> = {
  providerCallSid: "provider_call_sid", channel: "channel", fromE164: "from_e164", toE164: "to_e164", status: "status", endedAt: "ended_at", durationSec: "duration_sec",
  afterHours: "after_hours", priority: "priority", issue: "issue", outcome: "outcome", safetyFlags: "safety_flags", reasonCodes: "reason_codes", summary: "summary",
  transferStatus: "transfer_status", recordingUrl: "recording_url", missed: "missed", state: "state",
};

export class PgStore implements Store {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;

  constructor(connectionString: string, poolSize = 10) {
    this.pool = new pg.Pool({ connectionString, max: poolSize });
  }

  async close() {
    await this.pool.end();
  }

  async with<T>(ctx: Ctx, fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor', $3, true)",
        [ctx.tenantId ?? "", ctx.userId ?? "", ctx.actor],
      );
      const result = await fn((text, values) => client.query(text, values as unknown[]));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private t<T>(tenantId: string, fn: (q: Q) => Promise<T>) {
    return this.with({ tenantId, actor: "tenant" }, fn);
  }

  async getAgencySettings() {
    return this.with({ actor: "agency" }, async (q) => {
      const rows = await q("SELECT settings FROM agency_settings WHERE id = 1");
      return agencySettingsSchema.parse(rows.rows[0]?.settings ?? {});
    });
  }
  async applyAgencySettings(settings: AgencySettings) {
    return this.with({ actor: "agency" }, async (q) => {
      // Serializes global saves and account creation; a failed update rolls back the whole batch.
      await q("INSERT INTO agency_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
      const current = await q("SELECT settings FROM agency_settings WHERE id = 1 FOR UPDATE");
      const merged = agencySettingsSchema.parse({ ...current.rows[0]?.settings, ...settings });
      const accounts = await q("SELECT * FROM tenants ORDER BY id FOR UPDATE");
      for (const row of accounts.rows) {
        const config = applyAgencySettings(toTenant(row).config, settings);
        await q("UPDATE tenants SET config = $2, updated_at = now() WHERE id = $1", [row.id, JSON.stringify(config)]);
      }
      await q("UPDATE agency_settings SET settings = $1, updated_at = now() WHERE id = 1", [JSON.stringify(merged)]);
      return { settings: merged, updatedAccounts: accounts.rows.length };
    });
  }

  // tenants
  async listTenants() {
    return this.with({ actor: "agency" }, async (q) => (await q("SELECT * FROM tenants ORDER BY name")).rows.map(toTenant));
  }
  async getTenant(tenantId: string) {
    return this.t(tenantId, async (q) => {
      const r = await q("SELECT * FROM tenants WHERE id = $1", [tenantId]);
      return r.rows[0] ? toTenant(r.rows[0]) : null;
    });
  }
  async createTenant(input: { slug: string; name: string; config: TenantConfig; status?: Tenant["status"] }) {
    return this.with({ actor: "agency" }, async (q) => {
      await q("INSERT INTO agency_settings (id) VALUES (1) ON CONFLICT DO NOTHING");
      const defaults = await q("SELECT settings FROM agency_settings WHERE id = 1 FOR SHARE");
      const config = applyAgencySettings(input.config, agencySettingsSchema.parse(defaults.rows[0]?.settings ?? {}));
      const r = await q("INSERT INTO tenants (slug, name, config, status) VALUES ($1, $2, $3, $4) RETURNING *", [input.slug, input.name, JSON.stringify(config), input.status ?? "active"]);
      return toTenant(r.rows[0]);
    });
  }
  async updateTenantConfig(tenantId: string, config: TenantConfig, name?: string) {
    return this.t(tenantId, async (q) => {
      const r = await q("UPDATE tenants SET config = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1 RETURNING *", [tenantId, JSON.stringify(config), name ?? null]);
      if (!r.rows[0]) throw new Error("tenant not found");
      return toTenant(r.rows[0]);
    });
  }
  async setTenantStatus(tenantId: string, status: Tenant["status"]) {
    return this.t(tenantId, async (q) => {
      const r = await q("UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [tenantId, status]);
      if (!r.rows[0]) throw new Error("tenant not found");
      return toTenant(r.rows[0]);
    });
  }
  async resolveTenantByNumber(e164: string) {
    return this.with({ actor: "none" }, async (q) => {
      const r = await q("SELECT app.tenant_for_number($1) AS id", [e164]);
      return (r.rows[0]?.id as string | null) ?? null;
    });
  }
  async addPhoneNumber(tenantId: string, e164: string, providerSid?: string) {
    await this.t(tenantId, (q) => q("INSERT INTO phone_numbers (tenant_id, e164, provider_sid) VALUES ($1, $2, $3) ON CONFLICT (e164) DO NOTHING", [tenantId, e164, providerSid ?? null]));
  }
  async listPhoneNumbers(tenantId: string) {
    return this.t(tenantId, async (q) => (await q("SELECT e164 FROM phone_numbers WHERE tenant_id = $1 ORDER BY created_at", [tenantId])).rows.map((r) => String(r.e164)));
  }

  // users
  private toUser(r: Record<string, unknown>): User {
    return { id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), isAgencyAdmin: Boolean(r.is_agency_admin) };
  }
  async findUserByEmail(email: string) {
    return this.with({ actor: "auth" }, async (q) => {
      const r = await q("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
      return r.rows[0] ? this.toUser(r.rows[0]) : null;
    });
  }
  async getUser(userId: string) {
    return this.with({ actor: "auth", userId }, async (q) => {
      const r = await q("SELECT * FROM users WHERE id = $1", [userId]);
      return r.rows[0] ? this.toUser(r.rows[0]) : null;
    });
  }
  async createUser(input: { email: string; passwordHash: string; isAgencyAdmin?: boolean }) {
    return this.with({ actor: "agency" }, async (q) => {
      const r = await q("INSERT INTO users (email, password_hash, is_agency_admin) VALUES ($1, $2, $3) RETURNING *", [input.email.toLowerCase(), input.passwordHash, input.isAgencyAdmin ?? false]);
      return this.toUser(r.rows[0]);
    });
  }
  async addMembership(m: Membership) {
    await this.with({ actor: "agency" }, (q) => q("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [m.userId, m.tenantId, m.role]));
  }
  async listMemberships(userId: string) {
    return this.with({ actor: "auth", userId }, async (q) =>
      (await q("SELECT * FROM memberships WHERE user_id = $1", [userId])).rows.map((r) => ({ userId: String(r.user_id), tenantId: String(r.tenant_id), role: r.role as Membership["role"] })),
    );
  }

  // calls
  async createCall(tenantId: string, input: Pick<CallRecord, "fromE164" | "toE164" | "channel" | "afterHours"> & { providerCallSid?: string | null }) {
    return this.t(tenantId, async (q) => {
      const r = await q(
        "INSERT INTO calls (tenant_id, provider_call_sid, channel, from_e164, to_e164, after_hours) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [tenantId, input.providerCallSid ?? null, input.channel, input.fromE164, input.toE164, input.afterHours],
      );
      return toCall(r.rows[0]);
    });
  }
  async updateCall(tenantId: string, callId: string, patch: CallPatch) {
    const sets: string[] = [];
    const values: unknown[] = [tenantId, callId];
    for (const [key, value] of Object.entries(patch)) {
      const col = CALL_COLUMNS[key as keyof CallPatch];
      if (!col || value === undefined) continue;
      values.push(key === "state" ? JSON.stringify(value) : value);
      sets.push(`${col} = $${values.length}`);
    }
    return this.t(tenantId, async (q) => {
      const r = sets.length
        ? await q(`UPDATE calls SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2 RETURNING *`, values)
        : await q("SELECT * FROM calls WHERE tenant_id = $1 AND id = $2", values);
      if (!r.rows[0]) throw new Error("call not found");
      return toCall(r.rows[0]);
    });
  }
  async getCall(tenantId: string, callId: string) {
    return this.t(tenantId, async (q) => {
      const r = await q("SELECT * FROM calls WHERE tenant_id = $1 AND id = $2", [tenantId, callId]);
      return r.rows[0] ? toCall(r.rows[0]) : null;
    });
  }
  async getCallBySid(tenantId: string, sid: string) {
    return this.t(tenantId, async (q) => {
      const r = await q("SELECT * FROM calls WHERE tenant_id = $1 AND provider_call_sid = $2", [tenantId, sid]);
      return r.rows[0] ? toCall(r.rows[0]) : null;
    });
  }
  async listCalls(tenantId: string, opts: { limit?: number; priority?: CallRecord["priority"] } = {}) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM calls WHERE tenant_id = $1 AND ($2::text IS NULL OR priority = $2) ORDER BY started_at DESC LIMIT $3", [tenantId, opts.priority ?? null, opts.limit ?? 100])).rows.map(toCall),
    );
  }
  async appendTranscript(tenantId: string, callId: string, role: TranscriptTurn["role"], text: string) {
    await this.t(tenantId, (q) => q("INSERT INTO transcript_turns (tenant_id, call_id, role, text) VALUES ($1, $2, $3, $4)", [tenantId, callId, role, text]));
  }
  async listTranscript(tenantId: string, callId: string) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM transcript_turns WHERE tenant_id = $1 AND call_id = $2 ORDER BY id", [tenantId, callId])).rows.map((r) => ({
        id: Number(r.id), callId: String(r.call_id), role: r.role as TranscriptTurn["role"], text: String(r.text), at: ts(r.at),
      })),
    );
  }
  async appendEvent(tenantId: string, callId: string, type: string, data?: unknown) {
    await this.t(tenantId, (q) => q("INSERT INTO call_events (tenant_id, call_id, type, data) VALUES ($1, $2, $3, $4)", [tenantId, callId, type, data === undefined ? null : JSON.stringify(data)]));
  }
  async listEvents(tenantId: string, callId: string): Promise<CallEvent[]> {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM call_events WHERE tenant_id = $1 AND call_id = $2 ORDER BY id", [tenantId, callId])).rows.map((r) => ({ id: Number(r.id), callId: String(r.call_id), type: String(r.type), data: r.data, at: ts(r.at) })),
    );
  }

  // bookings
  async createBooking(tenantId: string, b: NewBooking) {
    return this.t(tenantId, async (q) => {
      const r = await q(
        `INSERT INTO bookings (tenant_id, call_id, service_key, priority, starts_at, ends_at, window_label, customer_name, customer_phone, address, zip, problem, sms_consent, status, calendar_event_id, fsm_provider, fsm_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [tenantId, b.callId, b.serviceKey, b.priority, b.startsAt, b.endsAt, b.windowLabel, b.customerName, b.customerPhone, b.address, b.zip, b.problem, b.smsConsent, b.status ?? "booked", b.calendarEventId, b.fsmProvider, b.fsmRef],
      );
      return toBooking(r.rows[0]);
    });
  }
  async createBookingIfCapacity(tenantId: string, b: NewBooking, capacity: number) {
    return this.t(tenantId, async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtext('bookings:' || $1::text))", [tenantId]);
      const overlap = await q(
        "SELECT count(*)::int AS n FROM bookings WHERE tenant_id = $1 AND status = 'booked' AND starts_at < $3 AND ends_at > $2",
        [tenantId, b.startsAt, b.endsAt],
      );
      if (Number(overlap.rows[0]?.n ?? 0) >= capacity) return null;
      const r = await q(
        `INSERT INTO bookings (tenant_id, call_id, service_key, priority, starts_at, ends_at, window_label, customer_name, customer_phone, address, zip, problem, sms_consent, status, calendar_event_id, fsm_provider, fsm_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [tenantId, b.callId, b.serviceKey, b.priority, b.startsAt, b.endsAt, b.windowLabel, b.customerName, b.customerPhone, b.address, b.zip, b.problem, b.smsConsent, b.status ?? "booked", b.calendarEventId, b.fsmProvider, b.fsmRef],
      );
      return toBooking(r.rows[0]);
    });
  }
  async updateBooking(tenantId: string, id: string, patch: Partial<Pick<BookingRecord, "calendarEventId" | "fsmProvider" | "fsmRef" | "status">>) {
    await this.t(tenantId, (q) =>
      q(
        "UPDATE bookings SET calendar_event_id = COALESCE($3, calendar_event_id), fsm_provider = COALESCE($4, fsm_provider), fsm_ref = COALESCE($5, fsm_ref), status = COALESCE($6, status) WHERE tenant_id = $1 AND id = $2",
        [tenantId, id, patch.calendarEventId ?? null, patch.fsmProvider ?? null, patch.fsmRef ?? null, patch.status ?? null],
      ),
    );
  }
  async listBookings(tenantId: string, opts: { from?: Date; to?: Date; limit?: number } = {}) {
    return this.t(tenantId, async (q) =>
      (await q(
        "SELECT * FROM bookings WHERE tenant_id = $1 AND ($2::timestamptz IS NULL OR ends_at > $2) AND ($3::timestamptz IS NULL OR starts_at < $3) ORDER BY starts_at LIMIT $4",
        [tenantId, opts.from ?? null, opts.to ?? null, opts.limit ?? 500],
      )).rows.map(toBooking),
    );
  }

  // sms
  async getConsent(tenantId: string, phone: string): Promise<ConsentStatus> {
    return this.t(tenantId, async (q) => ((await q("SELECT status FROM sms_consent WHERE tenant_id = $1 AND phone = $2", [tenantId, phone])).rows[0]?.status as ConsentStatus) ?? "unknown");
  }
  async setConsent(tenantId: string, phone: string, status: ConsentStatus, source: string) {
    await this.t(tenantId, (q) =>
      q("INSERT INTO sms_consent (tenant_id, phone, status, source) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, phone) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, updated_at = now()", [tenantId, phone, status, source]),
    );
  }
  async getOrCreateConversation(tenantId: string, phone: string): Promise<SmsConversation> {
    return this.t(tenantId, async (q) => {
      const r = await q(
        "INSERT INTO sms_conversations (tenant_id, phone) VALUES ($1, $2) ON CONFLICT (tenant_id, phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING *",
        [tenantId, phone],
      );
      const row = r.rows[0];
      return { id: String(row.id), tenantId, phone, callId: (row.call_id as string | null) ?? null, state: row.state ?? null, updatedAt: ts(row.updated_at) };
    });
  }
  async saveConversationState(tenantId: string, conversationId: string, state: unknown, callId?: string | null) {
    await this.t(tenantId, (q) =>
      q("UPDATE sms_conversations SET state = $3, call_id = COALESCE($4, call_id), updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, conversationId, JSON.stringify(state), callId ?? null]),
    );
  }
  async insertSms(tenantId: string, m: Omit<SmsMessage, "id" | "tenantId" | "createdAt">) {
    return this.t(tenantId, async (q) =>
      toSms(
        (await q(
          "INSERT INTO sms_messages (tenant_id, conversation_id, direction, from_e164, to_e164, body, purpose, status, provider_sid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [tenantId, m.conversationId, m.direction, m.fromE164, m.toE164, m.body, m.purpose, m.status, m.providerSid],
        )).rows[0],
      ),
    );
  }
  async updateSmsStatus(tenantId: string, id: string, status: string, providerSid?: string | null) {
    await this.t(tenantId, (q) => q("UPDATE sms_messages SET status = $3, provider_sid = COALESCE($4, provider_sid) WHERE tenant_id = $1 AND id = $2", [tenantId, id, status, providerSid ?? null]));
  }
  async listSms(tenantId: string, opts: { phone?: string; limit?: number } = {}) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM sms_messages WHERE tenant_id = $1 AND ($2::text IS NULL OR from_e164 = $2 OR to_e164 = $2) ORDER BY created_at DESC, id LIMIT $3", [tenantId, opts.phone ?? null, opts.limit ?? 200])).rows.map(toSms),
    );
  }

  async insertMissedCallText(tenantId: string, m: Omit<MissedCallText, "id" | "tenantId" | "createdAt">) {
    return this.t(tenantId, async (q) => {
      const r = (await q("INSERT INTO missed_call_texts (tenant_id, call_id, phone, status, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *", [tenantId, m.callId, m.phone, m.status, m.reason])).rows[0];
      return { id: String(r.id), tenantId, callId: (r.call_id as string | null) ?? null, phone: String(r.phone), status: r.status as MissedCallText["status"], reason: (r.reason as string | null) ?? null, createdAt: ts(r.created_at) };
    });
  }
  async listMissedCallTexts(tenantId: string, limit = 100) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM missed_call_texts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2", [tenantId, limit])).rows.map((r) => ({
        id: String(r.id), tenantId, callId: (r.call_id as string | null) ?? null, phone: String(r.phone), status: r.status as MissedCallText["status"], reason: (r.reason as string | null) ?? null, createdAt: ts(r.created_at),
      })),
    );
  }

  async createCallback(tenantId: string, c: Omit<CallbackTask, "id" | "tenantId" | "createdAt" | "status" | "completedAt">) {
    return this.t(tenantId, async (q) =>
      toCallback(
        (await q("INSERT INTO callback_tasks (tenant_id, call_id, priority, reason, caller_phone, name, notes, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [
          tenantId, c.callId, c.priority, c.reason, c.callerPhone, c.name, c.notes, c.dueAt,
        ])).rows[0],
      ),
    );
  }
  async listCallbacks(tenantId: string, opts: { status?: "open" | "done"; limit?: number } = {}) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM callback_tasks WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY due_at LIMIT $3", [tenantId, opts.status ?? null, opts.limit ?? 200])).rows.map(toCallback),
    );
  }
  async overdueUrgentCallbacks(cutoff: Date) {
    return this.with({ actor: "none" }, async (q) =>
      (await q("SELECT tenant_id, id FROM app.overdue_urgent_callbacks($1)", [cutoff.toISOString()])).rows.map((r) => ({ tenantId: String(r.tenant_id), id: String(r.id) })),
    );
  }
  async getCallback(tenantId: string, id: string) {
    return this.t(tenantId, async (q) => {
      const r = await q("SELECT * FROM callback_tasks WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
      return r.rows[0] ? toCallback(r.rows[0]) : null;
    });
  }
  async markCallbackEscalated(tenantId: string, id: string) {
    await this.t(tenantId, (q) => q("UPDATE callback_tasks SET escalated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]));
  }
  async completeCallback(tenantId: string, id: string) {
    await this.t(tenantId, async (q) => {
      const r = await q("UPDATE callback_tasks SET status = 'done', completed_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
      if (r.rowCount === 0) throw new Error("callback not found");
    });
  }
  async insertAlert(tenantId: string, a: Omit<OnCallAlertRecord, "id" | "tenantId" | "createdAt">) {
    return this.t(tenantId, async (q) => {
      const r = (await q("INSERT INTO oncall_alerts (tenant_id, call_id, priority, reason, recipients, body, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [
        tenantId, a.callId, a.priority, a.reason, JSON.stringify(a.recipients), a.body, a.status,
      ])).rows[0];
      return { ...a, id: String(r.id), tenantId, createdAt: ts(r.created_at) };
    });
  }
  async listAlerts(tenantId: string, limit = 100) {
    return this.t(tenantId, async (q) =>
      (await q("SELECT * FROM oncall_alerts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2", [tenantId, limit])).rows.map((r) => ({
        id: String(r.id), tenantId, callId: (r.call_id as string | null) ?? null, priority: String(r.priority), reason: String(r.reason),
        recipients: r.recipients as OnCallAlertRecord["recipients"], body: String(r.body), status: String(r.status), createdAt: ts(r.created_at),
      })),
    );
  }

  async stats(tenantId: string, now: Date): Promise<DashboardStats> {
    return this.t(tenantId, async (q) => {
      const r = await q(
        `SELECT
          (SELECT count(*) FROM calls WHERE tenant_id = $1 AND started_at >= $2::timestamptz - interval '1 day') AS calls_today,
          (SELECT count(*) FROM calls WHERE tenant_id = $1 AND started_at >= $2::timestamptz - interval '7 days') AS calls_7d,
          (SELECT count(*) FROM bookings WHERE tenant_id = $1 AND created_at >= $2::timestamptz - interval '7 days') AS bookings_7d,
          (SELECT count(*) FROM calls WHERE tenant_id = $1 AND priority = 'P1' AND started_at >= $2::timestamptz - interval '7 days') AS emergencies_7d,
          (SELECT count(*) FROM calls WHERE tenant_id = $1 AND priority = 'P0' AND started_at >= $2::timestamptz - interval '7 days') AS life_safety_7d,
          (SELECT count(*) FROM callback_tasks WHERE tenant_id = $1 AND status = 'open') AS open_callbacks,
          (SELECT count(*) FROM missed_call_texts WHERE tenant_id = $1 AND status = 'sent' AND created_at >= $2::timestamptz - interval '7 days') AS missed_7d`,
        [tenantId, now],
      );
      const row = r.rows[0] ?? {};
      return {
        callsToday: Number(row.calls_today), calls7d: Number(row.calls_7d), bookings7d: Number(row.bookings_7d), emergencies7d: Number(row.emergencies_7d),
        lifeSafety7d: Number(row.life_safety_7d), openCallbacks: Number(row.open_callbacks), missedCallTexts7d: Number(row.missed_7d),
      };
    });
  }
}
