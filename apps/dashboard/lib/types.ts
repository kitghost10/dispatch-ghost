import type { TenantConfig } from "../../../packages/core/src/tenant/config";
export type Priority = "P0" | "P1" | "P2" | "P3";

export interface TenantSummary {
  channels?: { voice: boolean; sms: boolean };
  agentName?: string;
  id: string;
  slug: string;
  name: string;
  status: string;
  numbers: string[];
  stats: Stats;
}

export interface Stats {
  callsToday: number;
  calls7d: number;
  bookings7d: number;
  emergencies7d: number;
  lifeSafety7d: number;
  openCallbacks: number;
  missedCallTexts7d: number;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  numbers: string[];
  config: TenantConfig;
}

export interface Call {
  id: string;
  channel: string;
  fromE164: string;
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
}

export interface Booking {
  id: string;
  callId: string | null;
  serviceKey: string;
  priority: Priority;
  startsAt: string;
  endsAt: string;
  windowLabel: string;
  customerName: string;
  customerPhone: string;
  address: string;
  zip: string | null;
  problem: string;
  status: string;
  calendarEventId: string | null;
  fsmProvider: string | null;
  fsmRef: string | null;
}

export interface Sms {
  id: string;
  direction: "inbound" | "outbound";
  fromE164: string;
  toE164: string;
  body: string;
  purpose: string;
  status: string;
  createdAt: string;
}

export interface MissedText {
  id: string;
  phone: string;
  status: string;
  reason: string | null;
  createdAt: string;
  callId: string | null;
}

export interface Callback {
  id: string;
  callId: string | null;
  priority: Priority;
  reason: string;
  callerPhone: string;
  name: string | null;
  notes: string;
  dueAt: string;
  status: "open" | "done";
}

export interface Alert {
  id: string;
  callId: string | null;
  priority: string;
  reason: string;
  recipients: Array<{ name: string; phone: string }>;
  body: string;
  status: string;
  createdAt: string;
}

export interface CallDetail {
  call: Call;
  facts: Record<string, unknown> | null;
  triage: { priority: Priority; reasonCodes: string[]; openQuestions: Array<{ key: string; prompt: string }> } | null;
  customer: Record<string, unknown> | null;
  transcript: Array<{ id: number; role: "caller" | "agent" | "system"; text: string; at: string }>;
  events: Array<{ id: number; type: string; data: unknown; at: string }>;
  bookings: Booking[];
}

export interface ProviderSetup {
  mode: "mock" | "live";
  baseUrl: string;
  defaultVoice: string;
  defaultSms: string;
  connections: Record<string, boolean>;
  defaults: { openrouterModel: string; openaiModel: string; smsModel: string; transcriptionModel: string; speechModel: string };
}
