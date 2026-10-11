/**
 * ReceptionistSession: the deterministic core of a call or SMS conversation.
 *
 * Both front-ends drive this class:
 *  - the realtime voice model, through tools (engine/tools.ts), and
 *  - the scripted receptionist (engine/scripted.ts) used in mock mode, tests
 *    and as the SMS fallback.
 *
 * Every rule that matters — safety lockout, triage, service area, no-quote,
 * adult-on-site, after-hours routing, transfer failure handling — is enforced
 * HERE, so it holds no matter what the language model says.
 */
import type { ServiceConfig, TenantConfig } from "../tenant/config";
import { spokenCompany } from "../tenant/config";
import { checkServiceArea, extractZip, type Geocoder, type ServiceAreaResult } from "../serviceArea";
import { isOpen, localNow, nextOpening, resolveOnCall } from "../schedule/hours";
import { matchService, type Slot } from "../schedule/slots";
import { extractSafetyFlags, mergeFlags } from "../triage/safety";
import { classifyIssue, escalateIssue, extractStatedFacts } from "../triage/issues";
import { determinePriority, morePressing } from "../triage/priority";
import { safetyScriptFor, SHUTOFF_GUIDANCE, WATER_HEATER_SHUTOFF } from "../triage/scripts";
import type { CallFacts, FactQuestionKey, IssueType, Priority, TriageDecision } from "../triage/types";
import { PRIORITY_LABEL } from "../triage/types";
import { tripFeeStatement } from "../pricing";
import type {
  AgentTurn,
  Channel,
  EffectSink,
  RuntimeAction,
  Scheduler,
  SessionState,
} from "./types";

export interface SessionDeps {
  config: TenantConfig;
  scheduler: Scheduler;
  effects: EffectSink;
  geocoder?: Geocoder;
  now?: () => Date;
  businessPhone?: string;
}

export interface ObserveResult {
  newSafetyFlags: string[];
  becameP0: boolean;
  triage: TriageDecision;
}

export function initialState(config: TenantConfig, input: { channel: Channel; callerPhone: string; now: Date }): SessionState {
  const facts: CallFacts = { issue: "unknown", description: [], safetyFlags: [] };
  const triage = determinePriority(facts, { vulnerableOccupantUpgradesToP1: config.triage.vulnerableOccupantUpgradesToP1 });
  return {
    channel: input.channel,
    callerPhone: input.callerPhone,
    startedAt: input.now.toISOString(),
    afterHours: !isOpen(config, input.now),
    facts,
    triage,
    peakPriority: triage.priority,
    feeStated: false,
    priceAsks: 0,
    shutoffGuidanceGiven: false,
    safetyScriptGiven: false,
    recordingNoticeGiven: false,
    slotsOffered: [],
    customer: { phone: input.callerPhone },
    callbackCreated: false,
    onCallAlerted: false,
    wantsHuman: false,
    declinedVisit: false,
    outcome: "in_progress",
    ended: false,
    turns: 0,
  };
}

export class ReceptionistSession {
  readonly config: TenantConfig;
  state: SessionState;
  private readonly deps: SessionDeps;

  constructor(deps: SessionDeps, init: { channel: Channel; callerPhone: string } | { state: SessionState }) {
    this.deps = deps;
    this.config = deps.config;
    this.state = "state" in init ? init.state : initialState(deps.config, { ...init, now: this.now() });
  }

  now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  get company(): string {
    return spokenCompany(this.config);
  }

  get isLockedForSafety(): boolean {
    return this.state.triage.priority === "P0" || this.state.peakPriority === "P0";
  }

  service(): ServiceConfig | undefined {
    return this.config.services.find((s) => s.key === this.state.serviceKey);
  }

  private event(type: string, data?: Record<string, unknown>) {
    this.deps.effects.event({ type, at: this.now().toISOString(), ...(data ? { data } : {}) });
  }

  // ---------------------------------------------------------------- triage --

  /**
   * Run on EVERY caller utterance (voice transcript or SMS body). Deterministic
   * safety scan + fact extraction. Returns whether the call just became P0 so
   * the voice runtime can interrupt the model and read the safety script.
   */
  observeCaller(text: string): ObserveResult {
    const s = this.state;
    s.turns += 1;
    const before = s.facts.safetyFlags.length;
    const flags = extractSafetyFlags(text);
    s.facts.description.push(text);
    s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, flags);
    let issue = classifyIssue(text, this.config.notOffered);
    // An answer to a triage question ("no electrical near it") is never a request for another trade.
    if ((issue === "not_offered" || issue === "gas_line_work") && s.pendingQuestion && s.pendingQuestion !== "issue") issue = "unknown";
    s.facts.issue = escalateIssue(s.facts.issue, issue);
    Object.assign(s.facts, stripUndefined(extractStatedFacts(text)));
    if (!s.customer.zip) {
      const zip = extractZip(text);
      if (zip) s.customer.zip = zip;
    }
    const answered = this.applyAnswerToPendingQuestion(text);
    if (!answered && s.pendingQuestion === "gasSmellCheck") s.facts.gasSmellChecked = true;
    const result = this.retriage();
    const newFlags = s.facts.safetyFlags.slice(before);
    if (newFlags.length) this.event("safety.flag", { flags: newFlags, text });
    return { newSafetyFlags: newFlags, becameP0: newFlags.length > 0, triage: result };
  }

  /** Structured facts reported by the language model (record_facts tool). */
  recordFacts(patch: Partial<CallFacts> & { issue?: IssueType; gasSmell?: boolean }): TriageDecision {
    const s = this.state;
    if (patch.safetyFlags?.length) s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, patch.safetyFlags);
    if (patch.gasSmell === true) s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, ["gas_odor"]);
    if (patch.gasSmell !== undefined) s.facts.gasSmellChecked = true;
    if (patch.issue) s.facts.issue = escalateIssue(s.facts.issue, patch.issue);
    for (const key of ["waterFlowing", "nearElectrical", "shutoffLocated", "shutoffClosed", "sewageInHome", "onlyToilet", "wholeHomeNoWater", "vulnerableOccupant", "callerSaidEmergency"] as const) {
      if (typeof patch[key] === "boolean") s.facts[key] = patch[key];
    }
    if (patch.nearElectrical === true) s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, ["water_near_electrical"]);
    return this.retriage();
  }

  retriage(): TriageDecision {
    const s = this.state;
    const decision = determinePriority(s.facts, { vulnerableOccupantUpgradesToP1: this.config.triage.vulnerableOccupantUpgradesToP1 });
    const changed = decision.priority !== s.triage.priority || decision.issue !== s.triage.issue;
    s.triage = decision;
    s.peakPriority = morePressing(s.peakPriority, decision.priority);
    if (!s.serviceKey && decision.issue !== "unknown") {
      const svc = matchService(this.config, s.facts.description.join(" "), decision.issue);
      if (svc) s.serviceKey = svc.key;
    }
    if (changed) this.event("triage.updated", { priority: decision.priority, issue: decision.issue, reasonCodes: decision.reasonCodes });
    return decision;
  }

  private applyAnswerToPendingQuestion(text: string): boolean {
    const s = this.state;
    const q = s.pendingQuestion;
    if (!q) return false;
    const yn = yesNo(text);
    const factKeys: FactQuestionKey[] = ["waterFlowing", "nearElectrical", "shutoffLocated", "sewageInHome", "vulnerableOccupant", "onlyToilet"];
    if ((factKeys as string[]).includes(q)) {
      if (yn === undefined) return false;
      const key = q as Exclude<FactQuestionKey, "gasSmellCheck" | "wholeHomeNoWater">;
      s.facts[key] = yn;
      if (key === "nearElectrical" && yn) s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, ["water_near_electrical"]);
      return true;
    }
    if (q === "wholeHomeNoWater") {
      if (/\b(every|all|whole|entire|nothing anywhere|everywhere)\b/i.test(text) || yn === true) s.facts.wholeHomeNoWater = true;
      else if (/\b(just|only|one)\b/i.test(text) || yn === false) s.facts.wholeHomeNoWater = false;
      return s.facts.wholeHomeNoWater !== undefined;
    }
    if (q === "gasSmellCheck") {
      s.facts.gasSmellChecked = true;
      if (yn === true) s.facts.safetyFlags = mergeFlags(s.facts.safetyFlags, ["gas_odor"]);
      return yn !== undefined;
    }
    return false;
  }

  // ---------------------------------------------------------- safety (P0) --

  /**
   * P0 handling: safety script, on-call alert, callback task, no booking.
   * Idempotent; safe to call from both the scripted agent and the voice runtime.
   */
  async handleLifeSafety(): Promise<AgentTurn> {
    const s = this.state;
    const script = safetyScriptFor(s.facts.safetyFlags, this.config.triage.gasUtilityLine);
    const first = !s.safetyScriptGiven;
    s.safetyScriptGiven = true;
    s.outcome = "safety_evacuate";
    s.booking = undefined;
    s.slotsOffered = [];
    if (!s.onCallAlerted) {
      s.onCallAlerted = true;
      await this.deps.effects.alertOnCall({
        priority: "P0",
        reason: "life_safety",
        callerPhone: s.callerPhone,
        summary: `LIFE SAFETY (${s.facts.safetyFlags.join(", ")}): ${s.facts.description.join(" / ").slice(0, 300)}`,
        recipients: this.onCallRecipients(),
      });
    }
    if (!s.callbackCreated) {
      s.callbackCreated = true;
      await this.deps.effects.createCallback({
        priority: "P0",
        reason: "life_safety_follow_up",
        callerPhone: s.callerPhone,
        notes: `Caller told to evacuate/call 911 (${script.kind}). Follow up once safe. Flags: ${s.facts.safetyFlags.join(", ")}`,
        dueInMinutes: this.config.transfer.emergencyCallbackMinutes,
        ...(s.customer.name ? { name: s.customer.name } : {}),
      });
    }
    this.event("safety.script", { kind: script.kind, flags: s.facts.safetyFlags });
    s.ended = true;
    const say = first ? script.text : "Please get to safety and call 911 from outside. We'll follow up once it's safe.";
    return { say, actions: [{ type: "hangup", reason: "life_safety" }] };
  }

  // ----------------------------------------------------------- pricing ---

  feeStatement(): string {
    this.state.feeStated = true;
    this.event("pricing.fee_stated");
    return tripFeeStatement(this.config, this.state.afterHours);
  }

  // ------------------------------------------------------- service area --

  async checkArea(input: { zip?: string; address?: string }): Promise<ServiceAreaResult> {
    const zip = input.zip ?? (input.address ? extractZip(input.address) : undefined);
    const result = await checkServiceArea(this.config, { ...(zip ? { zip } : {}), ...(input.address ? { address: input.address } : {}) }, this.deps.geocoder);
    this.state.area = result;
    if (result.zip) this.state.customer.zip = result.zip;
    this.event("service_area.checked", { ...result });
    if (!result.inArea && result.method !== "unknown") {
      this.state.outcome = "out_of_area";
    }
    return result;
  }

  // ---------------------------------------------------------- scheduling --

  /** Why booking is not allowed right now, or null. Enforced for every path. */
  bookingBlocker(): string | null {
    const s = this.state;
    if (this.isLockedForSafety) return "life_safety_not_schedulable";
    if (!s.triage.schedulable) return "service_not_offered";
    if (!s.area) return "service_area_not_checked";
    if (!s.area.inArea) return "out_of_service_area";
    if (!this.service()) return "service_not_identified";
    if (this.config.booking.mode === "request") return "booking_mode_request";
    return null;
  }

  async offerSlots(limit = 3): Promise<{ ok: true; slots: Slot[] } | { ok: false; reason: string }> {
    const blocker = this.bookingBlocker();
    if (blocker) return { ok: false, reason: blocker };
    const svc = this.service();
    if (!svc) return { ok: false, reason: "service_not_identified" };
    const slots = await this.deps.scheduler.findSlots({ serviceKey: svc.key, priority: this.state.triage.priority, limit });
    this.state.slotsOffered = slots;
    this.event("slots.offered", { count: slots.length, priority: this.state.triage.priority });
    if (slots.length === 0) return { ok: false, reason: "no_availability" };
    return { ok: true, slots };
  }

  chooseSlot(slotId: string): Slot | undefined {
    const slot = this.state.slotsOffered.find((x) => x.id === slotId);
    if (slot) this.state.chosenSlotId = slot.id;
    return slot;
  }

  chosenSlot(): Slot | undefined {
    return this.state.slotsOffered.find((x) => x.id === this.state.chosenSlotId);
  }

  async book(): Promise<{ ok: true; spoken: string; bookingId: string } | { ok: false; reason: string; say?: string }> {
    const s = this.state;
    const blocker = this.bookingBlocker();
    if (blocker) return { ok: false, reason: blocker };
    // A model or network retry must not create a second appointment.
    if (s.booking) return { ok: true, spoken: s.booking.slot.spoken, bookingId: s.booking.id };
    const slot = this.chosenSlot();
    if (!slot) return { ok: false, reason: "no_slot_chosen" };
    if (!s.customer.name) return { ok: false, reason: "missing_name" };
    if (!s.customer.phone) return { ok: false, reason: "missing_phone" };
    if (!s.customer.address) return { ok: false, reason: "missing_address" };
    if (this.config.booking.adultRequired) {
      if (s.customer.adultPresent === undefined) return { ok: false, reason: "missing_adult_present" };
      if (s.customer.adultPresent === false) {
        return {
          ok: false,
          reason: "adult_required",
          say: "Someone eighteen or older needs to be at the property when the plumber arrives — that's a firm rule. Is there a time when an adult can be there?",
        };
      }
    }
    if (s.customer.address && s.area?.inArea) {
      const addrZip = extractZip(s.customer.address);
      if (addrZip && addrZip !== s.area.zip) {
        const recheck = await this.checkArea({ address: s.customer.address, zip: addrZip });
        if (!recheck.inArea) return { ok: false, reason: "out_of_service_area" };
      }
    }
    const svc = this.service();
    if (!svc) return { ok: false, reason: "service_not_identified" };
    const result = await this.deps.scheduler.book({
      slot,
      serviceKey: svc.key,
      priority: s.triage.priority,
      customer: { ...s.customer, name: s.customer.name, phone: s.customer.phone },
      problem: s.facts.description.join(" / ").slice(0, 1000),
      channel: s.channel,
    });
    if (!result.ok) {
      this.event("booking.failed", { reason: result.reason });
      return { ok: false, reason: result.reason };
    }
    s.booking = { id: result.bookingId, slot, ...(result.externalRef ? { externalRef: result.externalRef } : {}) };
    s.outcome = "booked";
    this.event("booking.created", { bookingId: result.bookingId, slot: slot.spoken, priority: s.triage.priority });
    if (s.customer.smsConsent && this.deps.effects.sendConfirmationSms) {
      await this.deps.effects.sendConfirmationSms({
        to: s.customer.phone ?? s.callerPhone,
        body: `${this.config.brand.companyName}: You're booked ${slot.spoken} at ${s.customer.address}. ${this.config.pricing.tripFeeLabel[0]?.toUpperCase()}${this.config.pricing.tripFeeLabel.slice(1)}: $${this.config.pricing.tripFee}. Reply STOP to opt out.`,
      });
    }
    return { ok: true, spoken: slot.spoken, bookingId: result.bookingId };
  }

  // ------------------------------------------------------------ routing --

  onCallRecipients(): Array<{ name: string; phone: string }> {
    return resolveOnCall(this.config, this.now());
  }

  /**
   * Decide where a live human is. Emergencies after hours go to the on-call
   * rota; office hours go to the office line (or on-call if none).
   */
  transferTargets(target: "on_call" | "office" | "auto"): { target: "on_call" | "office"; numbers: string[] } {
    const onCall = this.onCallRecipients().map((r) => r.phone);
    const office = this.config.transfer.officeNumber ? [this.config.transfer.officeNumber] : [];
    const s = this.state;
    if (target === "office") return office.length ? { target: "office", numbers: office } : { target: "on_call", numbers: onCall };
    if (target === "on_call") return { target: "on_call", numbers: onCall };
    if (s.afterHours) return { target: "on_call", numbers: onCall };
    return office.length ? { target: "office", numbers: office } : { target: "on_call", numbers: onCall };
  }

  requestTransfer(target: "on_call" | "office" | "auto", reason: string): RuntimeAction | { type: "none"; reason: string } {
    const s = this.state;
    if (s.channel !== "voice") return { type: "none", reason: "sms_channel" };
    const t = this.transferTargets(target);
    if (t.numbers.length === 0) return { type: "none", reason: "no_transfer_number" };
    s.transfer = { target: t.target, numbers: t.numbers, status: "pending" };
    this.event("transfer.requested", { target: t.target, reason });
    return { type: "transfer", target: t.target, numbers: t.numbers, reason };
  }

  /**
   * Called by the runtime after the <Dial> completes. On failure: SMS the
   * on-call rota, create a callback task, and tell the caller honestly.
   */
  async transferResult(status: "connected" | "failed"): Promise<AgentTurn> {
    const s = this.state;
    if (!s.transfer) s.transfer = { target: "on_call", numbers: [], status };
    s.transfer.status = status;
    this.event(`transfer.${status}`, { target: s.transfer.target });
    if (status === "connected") {
      s.outcome = "transferred";
      s.ended = true;
      if (s.peakPriority === "P1" && this.config.onCall.alwaysAlertOnEmergency && !s.onCallAlerted) {
        s.onCallAlerted = true;
        await this.deps.effects.alertOnCall({ priority: "P1", reason: "emergency", callerPhone: s.callerPhone, summary: this.summary(), recipients: this.onCallRecipients() });
      }
      return { say: "", actions: [] };
    }
    const priority: Priority = s.peakPriority === "P0" ? "P0" : s.peakPriority === "P1" ? "P1" : s.peakPriority;
    if (!s.onCallAlerted) {
      s.onCallAlerted = true;
      await this.deps.effects.alertOnCall({
        priority,
        reason: "transfer_failed",
        callerPhone: s.callerPhone,
        summary: `MISSED TRANSFER ${PRIORITY_LABEL[priority]}: ${this.summary()}`,
        recipients: this.onCallRecipients(),
      });
    }
    if (!s.callbackCreated) {
      s.callbackCreated = true;
      await this.deps.effects.createCallback({
        priority,
        reason: "transfer_failed",
        callerPhone: s.callerPhone,
        notes: this.summary(),
        dueInMinutes: priority === "P1" || priority === "P0" ? this.config.transfer.emergencyCallbackMinutes : 120,
        ...(s.customer.name ? { name: s.customer.name } : {}),
      });
    }
    s.outcome = "transfer_failed_callback";
    s.ended = true;
    const mins = this.config.transfer.emergencyCallbackMinutes;
    const shutoff = s.facts.waterFlowing !== false && ["burst_pipe", "active_leak", "flooding", "water_heater_leak", "frozen_pipe"].includes(s.facts.issue);
    return {
      say:
        `I wasn't able to reach our on-call plumber directly, so I've sent them an urgent text with your details, and they'll call you back at this number within about ${mins} minutes.` +
        (shutoff ? ` In the meantime, keep the water shut off at the main if you can do it safely.` : "") +
        " If anything becomes unsafe, leave the house and call 911.",
      actions: [{ type: "hangup", reason: "transfer_failed_callback_created" }],
    };
  }

  async scheduleCallback(reason: string, notes?: string): Promise<string> {
    const s = this.state;
    const open = nextOpening(this.config, this.now());
    if (!s.callbackCreated) {
      s.callbackCreated = true;
      const due = open ? Math.max(15, Math.round((open.toMillis() - this.now().getTime()) / 60000) + 30) : 24 * 60;
      await this.deps.effects.createCallback({
        priority: s.triage.priority,
        reason,
        callerPhone: s.callerPhone,
        notes: notes ?? this.summary(),
        dueInMinutes: s.afterHours ? due : 60,
        ...(s.customer.name ? { name: s.customer.name } : {}),
      });
    }
    if (s.outcome === "in_progress") s.outcome = reason === "message" ? "message_taken" : "callback_scheduled";
    const when = s.afterHours && open ? `when the office opens ${open.hasSame(localNow(this.config, this.now()), "day") ? "today" : open.toFormat("cccc")} at ${open.toFormat(open.minute ? "h:mm a" : "h a")}` : "shortly";
    return when;
  }

  /** Emergency callback when no live transfer is possible (SMS channel, no numbers). */
  async scheduleEmergencyCallback(): Promise<number> {
    const s = this.state;
    const mins = this.config.transfer.emergencyCallbackMinutes;
    if (!s.callbackCreated) {
      s.callbackCreated = true;
      await this.deps.effects.createCallback({
        priority: s.triage.priority,
        reason: "emergency_callback",
        callerPhone: s.callerPhone,
        notes: this.summary(),
        dueInMinutes: mins,
        ...(s.customer.name ? { name: s.customer.name } : {}),
      });
    }
    return mins;
  }

  async alertOnCallBySms(): Promise<void> {
    const s = this.state;
    if (s.onCallAlerted) return;
    s.onCallAlerted = true;
    await this.deps.effects.alertOnCall({ priority: s.triage.priority, reason: "sms_emergency", callerPhone: s.callerPhone, summary: this.summary(), recipients: this.onCallRecipients() });
  }

  shutoffGuidance(): string {
    this.state.shutoffGuidanceGiven = true;
    this.event("guidance.shutoff");
    return this.state.facts.issue === "water_heater_leak" ? `${WATER_HEATER_SHUTOFF} ${SHUTOFF_GUIDANCE}` : SHUTOFF_GUIDANCE;
  }

  summary(): string {
    const s = this.state;
    const bits = [
      `${s.triage.priority} ${s.facts.issue.replace(/_/g, " ")}`,
      s.customer.name ? `name ${s.customer.name}` : null,
      `phone ${s.callerPhone}`,
      s.customer.address ? `addr ${s.customer.address}` : s.customer.zip ? `zip ${s.customer.zip}` : null,
      s.facts.waterFlowing !== undefined ? `water flowing: ${s.facts.waterFlowing ? "yes" : "no"}` : null,
      s.facts.shutoffLocated !== undefined ? `shutoff located: ${s.facts.shutoffLocated ? "yes" : "no"}` : null,
      s.facts.vulnerableOccupant ? "vulnerable occupant" : null,
      `said: "${s.facts.description.slice(0, 2).join(" / ").slice(0, 160)}"`,
    ];
    return bits.filter(Boolean).join("; ");
  }

  end(outcome?: SessionState["outcome"]): void {
    if (outcome && this.state.outcome === "in_progress") this.state.outcome = outcome;
    this.state.ended = true;
  }
}

export function yesNo(text: string): boolean | undefined {
  const t = text.toLowerCase().replace(/[’']/g, "'");
  const no = /\b(no|nope|nah|not really|negative|don'?t think so|not that i know|isn'?t|it'?s not|none|nowhere|i don'?t)\b/.test(t);
  const yes = /\b(yes|yeah|yep|yup|sure|correct|right|ok(ay)?|affirmative|absolutely|definitely|it is|there is|i do|we do|uh-huh|that works|sounds good|go ahead|please do)\b/.test(t);
  if (yes && !no) return true;
  if (no && !yes) return false;
  if (yes && no) {
    // "no, yes it is" — take whichever comes last.
    return t.search(/\b(yes|yeah|yep|yup|sure|correct|it is|i do)\b/) > t.search(/\b(no|nope|nah|not)\b/);
  }
  return undefined;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
