import type { ServiceAreaResult } from "../serviceArea";
import type { Slot } from "../schedule/slots";
import type { CallFacts, Priority, TriageDecision } from "../triage/types";
import type { FactQuestionKey } from "../triage/types";

export type Channel = "voice" | "sms";

export type Outcome =
  | "in_progress"
  | "booked"
  | "safety_evacuate"
  | "transferred"
  | "transfer_failed_callback"
  | "callback_scheduled"
  | "message_taken"
  | "out_of_area"
  | "declined_not_offered"
  | "price_only"
  | "abandoned";

export type PendingQuestion =
  | FactQuestionKey
  | "issue"
  | "zip"
  | "slot"
  | "name"
  | "address"
  | "adult"
  | "smsConsent"
  | "wantsVisit"
  | "callbackOk"
  | "anythingElse";

export interface CustomerInfo {
  name?: string;
  phone?: string;
  address?: string;
  zip?: string;
  adultPresent?: boolean;
  smsConsent?: boolean;
}

export interface SessionState {
  channel: Channel;
  callerPhone: string;
  startedAt: string;
  afterHours: boolean;
  facts: CallFacts & { gasSmellChecked?: boolean };
  triage: TriageDecision;
  /** Most severe priority seen this call (safety never downgrades). */
  peakPriority: Priority;
  feeStated: boolean;
  priceAsks: number;
  shutoffGuidanceGiven: boolean;
  safetyScriptGiven: boolean;
  recordingNoticeGiven: boolean;
  pendingQuestion?: PendingQuestion;
  area?: ServiceAreaResult;
  serviceKey?: string;
  slotsOffered: Slot[];
  chosenSlotId?: string;
  customer: CustomerInfo;
  booking?: { id: string; slot: Slot; externalRef?: string };
  transfer?: { target: "on_call" | "office"; numbers: string[]; status: "pending" | "connected" | "failed" };
  callbackCreated: boolean;
  onCallAlerted: boolean;
  wantsHuman: boolean;
  declinedVisit: boolean;
  outcome: Outcome;
  ended: boolean;
  turns: number;
}

export interface BookingRequest {
  slot: Slot;
  serviceKey: string;
  priority: Priority;
  customer: Required<Pick<CustomerInfo, "name" | "phone">> & CustomerInfo;
  problem: string;
  channel: Channel;
}

export type BookingResult = { ok: true; bookingId: string; externalRef?: string } | { ok: false; reason: string };

export interface Scheduler {
  findSlots(input: { serviceKey: string; priority: Priority; limit?: number }): Promise<Slot[]>;
  book(input: BookingRequest): Promise<BookingResult>;
}

export interface OnCallAlert {
  priority: Priority;
  reason: "life_safety" | "transfer_failed" | "emergency" | "sms_emergency";
  callerPhone: string;
  summary: string;
  recipients: Array<{ name: string; phone: string }>;
}

export interface CallbackTaskInput {
  priority: Priority;
  reason: string;
  callerPhone: string;
  name?: string;
  notes: string;
  dueInMinutes: number;
}

export interface SessionEvent {
  type: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface EffectSink {
  alertOnCall(alert: OnCallAlert): Promise<void>;
  createCallback(task: CallbackTaskInput): Promise<void>;
  sendConfirmationSms?(input: { to: string; body: string }): Promise<void>;
  event(event: SessionEvent): void;
}

export type RuntimeAction =
  | { type: "transfer"; target: "on_call" | "office"; numbers: string[]; reason: string }
  | { type: "hangup"; reason: string };

export interface AgentTurn {
  say: string;
  actions: RuntimeAction[];
}
