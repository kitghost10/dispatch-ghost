/**
 * In-memory Store for mock/dev mode and tests. Same contract as PgStore
 * (see test/store.contract.ts); data is lost on restart.
 */
import { randomUUID } from "node:crypto";
import { applyAgencySettings, type AgencySettings, type ConsentStatus, type TenantConfig } from "@sb/core";
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

const iso = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private agencySettings: AgencySettings = {};
  private tenants = new Map<string, Tenant>();
  private numbers = new Map<string, { tenantId: string; providerSid?: string }>();
  private users = new Map<string, User>();
  private memberships: Membership[] = [];
  private calls = new Map<string, CallRecord>();
  private transcript: TranscriptTurn[] = [];
  private events: CallEvent[] = [];
  private bookings = new Map<string, BookingRecord>();
  private consent = new Map<string, { status: ConsentStatus; source: string }>();
  private conversations = new Map<string, SmsConversation>();
  private sms: SmsMessage[] = [];
  private missed: MissedCallText[] = [];
  private callbacks = new Map<string, CallbackTask>();
  private alerts: OnCallAlertRecord[] = [];
  private seq = 0;

  async close(): Promise<void> {}

  async getAgencySettings() { return clone(this.agencySettings); }
  async applyAgencySettings(settings: AgencySettings) {
    const merged = { ...this.agencySettings, ...settings };
    // Validate all accounts before committing any changes.
    const updates = [...this.tenants.values()].map((tenant) => ({ ...tenant, config: applyAgencySettings(tenant.config, settings) }));
    this.agencySettings = clone(merged);
    for (const tenant of updates) this.tenants.set(tenant.id, tenant);
    return { settings: clone(merged), updatedAccounts: updates.length };
  }
  async listTenants() {
    return [...this.tenants.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name));
  }
  async getTenant(id: string) {
    const t = this.tenants.get(id);
    return t ? clone(t) : null;
  }
  async createTenant(input: { slug: string; name: string; config: TenantConfig; status?: Tenant["status"] }) {
    if ([...this.tenants.values()].some((t) => t.slug === input.slug)) throw new Error(`tenant slug ${input.slug} exists`);
    const t: Tenant = { id: randomUUID(), slug: input.slug, name: input.name, status: input.status ?? "active", config: applyAgencySettings(input.config, this.agencySettings), createdAt: iso() };
    this.tenants.set(t.id, t);
    return clone(t);
  }
  async updateTenantConfig(id: string, config: TenantConfig, name?: string) {
    const t = this.tenants.get(id);
    if (!t) throw new Error("tenant not found");
    t.config = clone(config);
    if (name) t.name = name;
    return clone(t);
  }
  async setTenantStatus(id: string, status: Tenant["status"]) {
    const t = this.tenants.get(id);
    if (!t) throw new Error("tenant not found");
    t.status = status;
    return clone(t);
  }
  async resolveTenantByNumber(e164: string) {
    return this.numbers.get(e164)?.tenantId ?? null;
  }
  async addPhoneNumber(tenantId: string, e164: string, providerSid?: string) {
    const existing = this.numbers.get(e164);
    if (existing && existing.tenantId !== tenantId) throw new Error("number belongs to another tenant");
    this.numbers.set(e164, { tenantId, ...(providerSid ? { providerSid } : {}) });
  }
  async listPhoneNumbers(tenantId: string) {
    return [...this.numbers.entries()].filter(([, v]) => v.tenantId === tenantId).map(([k]) => k);
  }

  async findUserByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email.toLowerCase());
    return u ? clone(u) : null;
  }
  async getUser(id: string) {
    const u = this.users.get(id);
    return u ? clone(u) : null;
  }
  async createUser(input: { email: string; passwordHash: string; isAgencyAdmin?: boolean }) {
    if (await this.findUserByEmail(input.email)) throw new Error("user exists");
    const u: User = { id: randomUUID(), email: input.email.toLowerCase(), passwordHash: input.passwordHash, isAgencyAdmin: input.isAgencyAdmin ?? false };
    this.users.set(u.id, u);
    return clone(u);
  }
  async addMembership(m: Membership) {
    if (!this.memberships.some((x) => x.userId === m.userId && x.tenantId === m.tenantId)) this.memberships.push({ ...m });
  }
  async listMemberships(userId: string) {
    return this.memberships.filter((m) => m.userId === userId).map(clone);
  }

  async createCall(tenantId: string, input: Pick<CallRecord, "fromE164" | "toE164" | "channel" | "afterHours"> & { providerCallSid?: string | null }) {
    const c: CallRecord = {
      id: randomUUID(), tenantId, providerCallSid: input.providerCallSid ?? null, channel: input.channel, fromE164: input.fromE164, toE164: input.toE164,
      status: "in_progress", startedAt: iso(), endedAt: null, durationSec: null, afterHours: input.afterHours, priority: null, issue: null, outcome: null,
      safetyFlags: [], reasonCodes: [], summary: null, transferStatus: null, recordingUrl: null, missed: false, state: null,
    };
    this.calls.set(c.id, c);
    return clone(c);
  }
  async updateCall(tenantId: string, callId: string, patch: CallPatch) {
    const c = this.calls.get(callId);
    if (!c || c.tenantId !== tenantId) throw new Error("call not found");
    Object.assign(c, clone(patch));
    return clone(c);
  }
  async getCall(tenantId: string, callId: string) {
    const c = this.calls.get(callId);
    return c && c.tenantId === tenantId ? clone(c) : null;
  }
  async getCallBySid(tenantId: string, sid: string) {
    const c = [...this.calls.values()].find((x) => x.tenantId === tenantId && x.providerCallSid === sid);
    return c ? clone(c) : null;
  }
  async listCalls(tenantId: string, opts: { limit?: number; priority?: CallRecord["priority"] } = {}) {
    return [...this.calls.values()]
      .filter((c) => c.tenantId === tenantId && (!opts.priority || c.priority === opts.priority))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, opts.limit ?? 100)
      .map(clone);
  }
  async appendTranscript(tenantId: string, callId: string, role: TranscriptTurn["role"], text: string) {
    if (!(await this.getCall(tenantId, callId))) throw new Error("call not found");
    this.transcript.push({ id: ++this.seq, callId, role, text, at: iso() });
  }
  async listTranscript(tenantId: string, callId: string) {
    if (!(await this.getCall(tenantId, callId))) return [];
    return this.transcript.filter((t) => t.callId === callId).map(clone);
  }
  async appendEvent(tenantId: string, callId: string, type: string, data?: unknown) {
    if (!(await this.getCall(tenantId, callId))) throw new Error("call not found");
    this.events.push({ id: ++this.seq, callId, type, data: data ?? null, at: iso() });
  }
  async listEvents(tenantId: string, callId: string) {
    if (!(await this.getCall(tenantId, callId))) return [];
    return this.events.filter((e) => e.callId === callId).map(clone);
  }

  async createBooking(tenantId: string, b: NewBooking) {
    const rec: BookingRecord = { ...clone(b), id: randomUUID(), tenantId, status: b.status ?? "booked", createdAt: iso() };
    this.bookings.set(rec.id, rec);
    return clone(rec);
  }
  async createBookingIfCapacity(tenantId: string, b: NewBooking, capacity: number) {
    const overlapping = [...this.bookings.values()].filter(
      (x) => x.tenantId === tenantId && x.status === "booked" && x.startsAt < b.endsAt && x.endsAt > b.startsAt,
    ).length;
    if (overlapping >= capacity) return null;
    return this.createBooking(tenantId, b);
  }
  async updateBooking(tenantId: string, id: string, patch: Partial<Pick<BookingRecord, "calendarEventId" | "fsmProvider" | "fsmRef" | "status">>) {
    const b = this.bookings.get(id);
    if (!b || b.tenantId !== tenantId) throw new Error("booking not found");
    Object.assign(b, patch);
  }
  async listBookings(tenantId: string, opts: { from?: Date; to?: Date; limit?: number } = {}) {
    return [...this.bookings.values()]
      .filter((b) => b.tenantId === tenantId)
      .filter((b) => !opts.from || new Date(b.endsAt) > opts.from)
      .filter((b) => !opts.to || new Date(b.startsAt) < opts.to)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, opts.limit ?? 500)
      .map(clone);
  }

  async getConsent(tenantId: string, phone: string) {
    return this.consent.get(`${tenantId}:${phone}`)?.status ?? "unknown";
  }
  async setConsent(tenantId: string, phone: string, status: ConsentStatus, source: string) {
    this.consent.set(`${tenantId}:${phone}`, { status, source });
  }
  async getOrCreateConversation(tenantId: string, phone: string) {
    const key = `${tenantId}:${phone}`;
    let c = this.conversations.get(key);
    if (!c) {
      c = { id: randomUUID(), tenantId, phone, callId: null, state: null, updatedAt: iso() };
      this.conversations.set(key, c);
    }
    return clone(c);
  }
  async saveConversationState(tenantId: string, conversationId: string, state: unknown, callId?: string | null) {
    const c = [...this.conversations.values()].find((x) => x.id === conversationId && x.tenantId === tenantId);
    if (!c) throw new Error("conversation not found");
    c.state = clone(state);
    if (callId !== undefined) c.callId = callId;
    c.updatedAt = iso();
  }
  async insertSms(tenantId: string, msg: Omit<SmsMessage, "id" | "tenantId" | "createdAt">) {
    const m: SmsMessage = { ...msg, id: randomUUID(), tenantId, createdAt: iso() };
    this.sms.push(m);
    return clone(m);
  }
  async updateSmsStatus(tenantId: string, id: string, status: string, providerSid?: string | null) {
    const m = this.sms.find((x) => x.id === id && x.tenantId === tenantId);
    if (m) {
      m.status = status;
      if (providerSid !== undefined) m.providerSid = providerSid;
    }
  }
  async listSms(tenantId: string, opts: { phone?: string; limit?: number } = {}) {
    return this.sms
      .filter((m) => m.tenantId === tenantId && (!opts.phone || m.fromE164 === opts.phone || m.toE164 === opts.phone))
      .slice()
      .reverse()
      .slice(0, opts.limit ?? 200)
      .map(clone);
  }

  async insertMissedCallText(tenantId: string, input: Omit<MissedCallText, "id" | "tenantId" | "createdAt">) {
    const m: MissedCallText = { ...input, id: randomUUID(), tenantId, createdAt: iso() };
    this.missed.push(m);
    return clone(m);
  }
  async listMissedCallTexts(tenantId: string, limit = 100) {
    return this.missed.filter((m) => m.tenantId === tenantId).slice().reverse().slice(0, limit).map(clone);
  }

  async createCallback(tenantId: string, input: Omit<CallbackTask, "id" | "tenantId" | "createdAt" | "status" | "completedAt">) {
    const t: CallbackTask = { ...input, id: randomUUID(), tenantId, status: "open", createdAt: iso(), completedAt: null };
    this.callbacks.set(t.id, t);
    return clone(t);
  }
  async listCallbacks(tenantId: string, opts: { status?: "open" | "done"; limit?: number } = {}) {
    return [...this.callbacks.values()]
      .filter((c) => c.tenantId === tenantId && (!opts.status || c.status === opts.status))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, opts.limit ?? 200)
      .map(clone);
  }
  async overdueUrgentCallbacks(cutoff: Date) {
    return [...this.callbacks.values()]
      .filter((c) => c.status === "open" && !c.escalatedAt && (c.priority === "P0" || c.priority === "P1") && new Date(c.dueAt).getTime() <= cutoff.getTime())
      .map((c) => ({ tenantId: c.tenantId, id: c.id }));
  }
  async getCallback(tenantId: string, id: string) {
    const c = this.callbacks.get(id);
    return c && c.tenantId === tenantId ? clone(c) : null;
  }
  async markCallbackEscalated(tenantId: string, id: string) {
    const c = this.callbacks.get(id);
    if (c && c.tenantId === tenantId) c.escalatedAt = iso();
  }
  async completeCallback(tenantId: string, id: string) {
    const c = this.callbacks.get(id);
    if (!c || c.tenantId !== tenantId) throw new Error("callback not found");
    c.status = "done";
    c.completedAt = iso();
  }
  async insertAlert(tenantId: string, input: Omit<OnCallAlertRecord, "id" | "tenantId" | "createdAt">) {
    const a: OnCallAlertRecord = { ...clone(input), id: randomUUID(), tenantId, createdAt: iso() };
    this.alerts.push(a);
    return clone(a);
  }
  async listAlerts(tenantId: string, limit = 100) {
    return this.alerts.filter((a) => a.tenantId === tenantId).slice().reverse().slice(0, limit).map(clone);
  }

  async stats(tenantId: string, now: Date): Promise<DashboardStats> {
    const dayAgo = now.getTime() - 24 * 3600e3;
    const weekAgo = now.getTime() - 7 * 24 * 3600e3;
    const calls = [...this.calls.values()].filter((c) => c.tenantId === tenantId);
    const recent = calls.filter((c) => new Date(c.startedAt).getTime() >= weekAgo);
    return {
      callsToday: calls.filter((c) => new Date(c.startedAt).getTime() >= dayAgo).length,
      calls7d: recent.length,
      bookings7d: [...this.bookings.values()].filter((b) => b.tenantId === tenantId && new Date(b.createdAt).getTime() >= weekAgo).length,
      emergencies7d: recent.filter((c) => c.priority === "P1").length,
      lifeSafety7d: recent.filter((c) => c.priority === "P0").length,
      openCallbacks: [...this.callbacks.values()].filter((c) => c.tenantId === tenantId && c.status === "open").length,
      missedCallTexts7d: this.missed.filter((m) => m.tenantId === tenantId && new Date(m.createdAt).getTime() >= weekAgo && m.status === "sent").length,
    };
  }
}
