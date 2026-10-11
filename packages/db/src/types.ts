import type { AgencySettings, ConsentStatus, Priority, TenantConfig } from "@sb/core";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "onboarding" | "active" | "paused";
  config: TenantConfig;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  isAgencyAdmin: boolean;
}

export interface Membership {
  userId: string;
  tenantId: string;
  role: "owner" | "staff";
}

export interface CallRecord {
  id: string;
  tenantId: string;
  providerCallSid: string | null;
  channel: "voice" | "sms" | "simulator";
  fromE164: string;
  toE164: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  afterHours: boolean;
  priority: Priority | null;
  issue: string | null;
  outcome: string | null;
  safetyFlags: string[];
  reasonCodes: string[];
  summary: string | null;
  transferStatus: string | null;
  recordingUrl: string | null;
  missed: boolean;
  state: unknown;
}

export type CallPatch = Partial<Omit<CallRecord, "id" | "tenantId" | "startedAt">>;

export interface TranscriptTurn {
  id: number;
  callId: string;
  role: "caller" | "agent" | "system";
  text: string;
  at: string;
}

export interface CallEvent {
  id: number;
  callId: string;
  type: string;
  data: unknown;
  at: string;
}

export interface BookingRecord {
  id: string;
  tenantId: string;
  callId: string | null;
  serviceKey: string;
  priority: "P1" | "P2" | "P3";
  startsAt: string;
  endsAt: string;
  windowLabel: string;
  customerName: string;
  customerPhone: string;
  address: string;
  zip: string | null;
  problem: string;
  smsConsent: boolean;
  status: "booked" | "cancelled" | "completed";
  calendarEventId: string | null;
  fsmProvider: string | null;
  fsmRef: string | null;
  createdAt: string;
}

export type NewBooking = Omit<BookingRecord, "id" | "tenantId" | "createdAt" | "status"> & { status?: BookingRecord["status"] };

export interface SmsMessage {
  id: string;
  tenantId: string;
  conversationId: string | null;
  direction: "inbound" | "outbound";
  fromE164: string;
  toE164: string;
  body: string;
  purpose: string;
  status: string;
  providerSid: string | null;
  createdAt: string;
}

export interface SmsConversation {
  id: string;
  tenantId: string;
  phone: string;
  callId: string | null;
  state: unknown;
  updatedAt: string;
}

export interface MissedCallText {
  id: string;
  tenantId: string;
  callId: string | null;
  phone: string;
  status: "sent" | "queued" | "skipped" | "failed";
  reason: string | null;
  createdAt: string;
}

export interface CallbackTask {
  id: string;
  tenantId: string;
  callId: string | null;
  priority: Priority;
  reason: string;
  callerPhone: string;
  name: string | null;
  notes: string;
  dueAt: string;
  status: "open" | "done";
  createdAt: string;
  completedAt: string | null;
  escalatedAt?: string | null;
}

export interface OnCallAlertRecord {
  id: string;
  tenantId: string;
  callId: string | null;
  priority: string;
  reason: string;
  recipients: Array<{ name: string; phone: string }>;
  body: string;
  status: string;
  createdAt: string;
}

export interface DashboardStats {
  callsToday: number;
  calls7d: number;
  bookings7d: number;
  emergencies7d: number;
  lifeSafety7d: number;
  openCallbacks: number;
  missedCallTexts7d: number;
}

/**
 * Persistence boundary. Every method that touches tenant data takes the
 * tenant id explicitly; the Postgres implementation also sets it as RLS
 * context so a bug in a query cannot cross tenants.
 */
export interface Store {
  getAgencySettings(): Promise<AgencySettings>;
  applyAgencySettings(settings: AgencySettings): Promise<{ settings: AgencySettings; updatedAccounts: number }>;
  readonly kind: "memory" | "postgres";
  close(): Promise<void>;

  // tenants & numbers
  listTenants(): Promise<Tenant[]>;
  getTenant(tenantId: string): Promise<Tenant | null>;
  createTenant(input: { slug: string; name: string; config: TenantConfig; status?: Tenant["status"] }): Promise<Tenant>;
  updateTenantConfig(tenantId: string, config: TenantConfig, name?: string): Promise<Tenant>;
  setTenantStatus(tenantId: string, status: Tenant["status"]): Promise<Tenant>;
  resolveTenantByNumber(e164: string): Promise<string | null>;
  addPhoneNumber(tenantId: string, e164: string, providerSid?: string): Promise<void>;
  listPhoneNumbers(tenantId: string): Promise<string[]>;

  // users
  findUserByEmail(email: string): Promise<User | null>;
  getUser(userId: string): Promise<User | null>;
  createUser(input: { email: string; passwordHash: string; isAgencyAdmin?: boolean }): Promise<User>;
  addMembership(m: Membership): Promise<void>;
  listMemberships(userId: string): Promise<Membership[]>;

  // calls
  createCall(tenantId: string, input: Pick<CallRecord, "fromE164" | "toE164" | "channel" | "afterHours"> & { providerCallSid?: string | null }): Promise<CallRecord>;
  updateCall(tenantId: string, callId: string, patch: CallPatch): Promise<CallRecord>;
  getCall(tenantId: string, callId: string): Promise<CallRecord | null>;
  getCallBySid(tenantId: string, sid: string): Promise<CallRecord | null>;
  listCalls(tenantId: string, opts?: { limit?: number; priority?: Priority }): Promise<CallRecord[]>;
  appendTranscript(tenantId: string, callId: string, role: TranscriptTurn["role"], text: string): Promise<void>;
  listTranscript(tenantId: string, callId: string): Promise<TranscriptTurn[]>;
  appendEvent(tenantId: string, callId: string, type: string, data?: unknown): Promise<void>;
  listEvents(tenantId: string, callId: string): Promise<CallEvent[]>;

  // bookings
  createBooking(tenantId: string, booking: NewBooking): Promise<BookingRecord>;
  /**
   * Insert only if fewer than `capacity` active bookings overlap the window.
   * Serialised per tenant (advisory lock in Postgres) to prevent double-booking.
   */
  createBookingIfCapacity(tenantId: string, booking: NewBooking, capacity: number): Promise<BookingRecord | null>;
  updateBooking(tenantId: string, bookingId: string, patch: Partial<Pick<BookingRecord, "calendarEventId" | "fsmProvider" | "fsmRef" | "status">>): Promise<void>;
  listBookings(tenantId: string, opts?: { from?: Date; to?: Date; limit?: number }): Promise<BookingRecord[]>;

  // sms
  getConsent(tenantId: string, phone: string): Promise<ConsentStatus>;
  setConsent(tenantId: string, phone: string, status: ConsentStatus, source: string): Promise<void>;
  getOrCreateConversation(tenantId: string, phone: string): Promise<SmsConversation>;
  saveConversationState(tenantId: string, conversationId: string, state: unknown, callId?: string | null): Promise<void>;
  insertSms(tenantId: string, msg: Omit<SmsMessage, "id" | "tenantId" | "createdAt">): Promise<SmsMessage>;
  updateSmsStatus(tenantId: string, id: string, status: string, providerSid?: string | null): Promise<void>;
  listSms(tenantId: string, opts?: { phone?: string; limit?: number }): Promise<SmsMessage[]>;

  // missed call text-back
  insertMissedCallText(tenantId: string, input: Omit<MissedCallText, "id" | "tenantId" | "createdAt">): Promise<MissedCallText>;
  listMissedCallTexts(tenantId: string, limit?: number): Promise<MissedCallText[]>;

  // callbacks & alerts
  createCallback(tenantId: string, input: Omit<CallbackTask, "id" | "tenantId" | "createdAt" | "status" | "completedAt">): Promise<CallbackTask>;
  listCallbacks(tenantId: string, opts?: { status?: "open" | "done"; limit?: number }): Promise<CallbackTask[]>;
  completeCallback(tenantId: string, id: string): Promise<void>;
  /** Open P0/P1 callbacks past due and not yet escalated, across tenants (ids only). */
  overdueUrgentCallbacks(cutoff: Date): Promise<Array<{ tenantId: string; id: string }>>;
  getCallback(tenantId: string, id: string): Promise<CallbackTask | null>;
  markCallbackEscalated(tenantId: string, id: string): Promise<void>;
  insertAlert(tenantId: string, input: Omit<OnCallAlertRecord, "id" | "tenantId" | "createdAt">): Promise<OnCallAlertRecord>;
  listAlerts(tenantId: string, limit?: number): Promise<OnCallAlertRecord[]>;

  stats(tenantId: string, now: Date): Promise<DashboardStats>;
}
