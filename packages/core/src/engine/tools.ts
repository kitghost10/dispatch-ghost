/**
 * Tools exposed to the voice (and optional SMS) language model. Each tool is a
 * thin adapter over ReceptionistSession, so the model can only do what the
 * deterministic policy allows. Results carry `mustSay` text the model is told
 * to read verbatim (safety scripts, fee statement, refusals).
 */
import { isPriceQuestion, noQuoteStatement } from "../pricing";
import { SAFETY_FLAGS, ISSUE_TYPES, type SafetyFlag } from "../triage/types";
import { safetyScriptFor } from "../triage/scripts";
import type { ReceptionistSession } from "./session";
import type { RuntimeAction } from "./types";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const bool = { type: "boolean" } as const;

export const RECEPTIONIST_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    name: "record_facts",
    description:
      "Record facts about the plumbing problem as soon as the caller states them. Call this after EVERY caller answer about the problem. Returns the authoritative priority, whether booking is allowed, text you must say, and the next question to ask. Never decide urgency yourself.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        issue: { type: "string", enum: ISSUE_TYPES },
        callerWords: { type: "string", description: "The caller's description in their own words." },
        waterFlowing: bool,
        nearElectrical: { type: "boolean", description: "Water near outlets, panel, cords, light fixtures." },
        shutoffLocated: bool,
        shutoffClosed: bool,
        sewageInHome: bool,
        onlyToilet: bool,
        wholeHomeNoWater: bool,
        vulnerableOccupant: { type: "boolean", description: "Infant, elderly, or medical need in the home." },
        gasSmell: { type: "boolean", description: "Caller smells gas / rotten eggs. true triggers life-safety." },
        safetyFlags: { type: "array", items: { type: "string", enum: SAFETY_FLAGS } },
      },
    },
  },
  {
    type: "function",
    name: "get_pricing",
    description: "Get the approved fee statement. The trip/diagnostic fee is the only price you may say. Never quote repair prices.",
    parameters: { type: "object", additionalProperties: false, properties: { pushedAgain: bool } },
  },
  {
    type: "function",
    name: "check_service_area",
    description: "Check the property's ZIP code (or full address) against the service area. Required before offering times or transferring an emergency.",
    parameters: { type: "object", additionalProperties: false, properties: { zip: { type: "string" }, address: { type: "string" } } },
  },
  {
    type: "function",
    name: "find_availability",
    description: "Get bookable arrival windows. Refused for life-safety calls, out-of-area callers, and unidentified services.",
    parameters: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 5 } } },
  },
  {
    type: "function",
    name: "book_appointment",
    description:
      "Book one of the windows returned by find_availability after the caller confirms it, and after collecting name, street address, whether an adult (18+) will be present, and SMS consent.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["slotId", "name", "address", "adultPresent", "smsConsent"],
      properties: {
        slotId: { type: "string" },
        name: { type: "string" },
        address: { type: "string" },
        adultPresent: bool,
        smsConsent: bool,
        callbackPhone: { type: "string", description: "Only if different from caller ID, E.164." },
      },
    },
  },
  {
    type: "function",
    name: "transfer_call",
    description: "Transfer to a live person. Use target on_call for emergencies (the system picks the on-call plumber), office for billing/complaints/human requests during hours.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target", "reason"],
      properties: { target: { type: "string", enum: ["on_call", "office"] }, reason: { type: "string" } },
    },
  },
  {
    type: "function",
    name: "take_message",
    description: "Create a callback task for the team (caller wants a human after hours, complaint, billing, anything you cannot handle).",
    parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" }, name: { type: "string" } } },
  },
  {
    type: "function",
    name: "end_call",
    description: "End the call after saying goodbye, only on a clear closing cue or obvious spam.",
    parameters: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string" } } },
  },
];

export interface ToolExecution {
  output: Record<string, unknown>;
  /** Performed by the runtime after the model's spoken reply finishes. */
  action?: RuntimeAction;
}

export async function executeTool(session: ReceptionistSession, name: string, rawArgs: unknown): Promise<ToolExecution> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const s = session.state;

  if (session.isLockedForSafety && name !== "end_call" && name !== "record_facts") {
    const script = safetyScriptFor(s.facts.safetyFlags, session.config.triage.gasUtilityLine);
    if (!s.safetyScriptGiven) await session.handleLifeSafety();
    return { output: { ok: false, error: "life_safety_lockout", mustSay: script.text, instruction: "Say mustSay verbatim, then end the call. Do not book." }, action: { type: "hangup", reason: "life_safety" } };
  }

  switch (name) {
    case "record_facts": {
      if (typeof args.callerWords === "string" && args.callerWords.trim()) session.observeCaller(args.callerWords);
      const flags = Array.isArray(args.safetyFlags) ? (args.safetyFlags.filter((f) => (SAFETY_FLAGS as readonly string[]).includes(String(f))) as SafetyFlag[]) : undefined;
      const decision = session.recordFacts({
        ...(typeof args.issue === "string" && (ISSUE_TYPES as readonly string[]).includes(args.issue) ? { issue: args.issue as (typeof ISSUE_TYPES)[number] } : {}),
        ...pickBooleans(args, ["waterFlowing", "nearElectrical", "shutoffLocated", "shutoffClosed", "sewageInHome", "onlyToilet", "wholeHomeNoWater", "vulnerableOccupant", "gasSmell"]),
        ...(flags ? { safetyFlags: flags } : {}),
      });
      if (decision.priority === "P0") {
        const turn = await session.handleLifeSafety();
        return { output: { priority: "P0", lifeSafety: true, schedulable: false, mustSay: turn.say, instruction: "Say mustSay verbatim now, then end the call. Never book." }, action: { type: "hangup", reason: "life_safety" } };
      }
      const flowing = s.facts.waterFlowing === true && s.facts.shutoffClosed !== true;
      const guidance = flowing && s.facts.nearElectrical === false && !s.shutoffGuidanceGiven ? session.shutoffGuidance() : undefined;
      return {
        output: {
          priority: decision.priority,
          issue: decision.issue,
          schedulable: decision.schedulable,
          sameDay: decision.sameDay,
          needsLiveHuman: decision.requiresLiveHuman && (s.afterHours || session.config.triage.transferP1DuringHours),
          afterHours: s.afterHours,
          nextQuestion: decision.openQuestions[0]?.prompt ?? null,
          ...(guidance ? { mustSay: guidance } : {}),
          ...(!s.feeStated && decision.priority !== "P1" ? { alsoSay: session.feeStatement() } : {}),
          ...(decision.schedulable ? {} : { instruction: "We don't do this work. Say so politely and end the call. Do not book." }),
        },
      };
    }
    case "get_pricing": {
      s.priceAsks += 1;
      const pushed = args.pushedAgain === true || s.priceAsks >= 2;
      const statement = s.feeStated ? noQuoteStatement(session.config, session.service(), pushed) : session.feeStatement();
      s.feeStated = true;
      return { output: { mustSay: statement, rule: "Never quote a repair price, range, or 'usually around'." } };
    }
    case "check_service_area": {
      const res = await session.checkArea({
        ...(typeof args.zip === "string" ? { zip: args.zip } : {}),
        ...(typeof args.address === "string" ? { address: args.address } : {}),
      });
      if (res.inArea) return { output: { inArea: true, zip: res.zip } };
      if (res.method === "unknown") return { output: { inArea: false, reason: res.reason, instruction: "Ask for the 5-digit ZIP code of the property." } };
      const where = session.config.serviceArea.description;
      return {
        output: {
          inArea: false,
          mustSay: `I'm sorry, we don't service ${res.zip ?? "that area"}.${where ? ` We cover ${where}.` : ""}`,
          instruction: "Do not book or transfer. If urgent, suggest a local plumber and shut-off guidance, then end the call.",
        },
      };
    }
    case "find_availability": {
      const res = await session.offerSlots(typeof args.limit === "number" ? args.limit : 3);
      if (!res.ok) {
        const instruction =
          res.reason === "service_area_not_checked" ? "Call check_service_area first." :
          res.reason === "booking_mode_request" || res.reason === "no_availability" ? "Offer a callback with take_message." :
          res.reason === "service_not_identified" ? "Ask what the problem is and call record_facts." :
          "Do not book.";
        return { output: { ok: false, reason: res.reason, instruction } };
      }
      return { output: { ok: true, slots: res.slots.map((x) => ({ slotId: x.id, spoken: x.spoken })), instruction: "Offer these windows using the spoken text. Never promise an exact minute." } };
    }
    case "book_appointment": {
      if (typeof args.slotId === "string") session.chooseSlot(args.slotId);
      if (typeof args.name === "string") s.customer.name = args.name;
      if (typeof args.address === "string") s.customer.address = args.address;
      if (typeof args.adultPresent === "boolean") s.customer.adultPresent = args.adultPresent;
      if (typeof args.smsConsent === "boolean") s.customer.smsConsent = args.smsConsent;
      if (typeof args.callbackPhone === "string" && /^\+[1-9]\d{7,14}$/.test(args.callbackPhone)) s.customer.phone = args.callbackPhone;
      const res = await session.book();
      if (!res.ok) return { output: { ok: false, reason: res.reason, ...(res.say ? { mustSay: res.say } : {}) } };
      return { output: { ok: true, bookingId: res.bookingId, spoken: res.spoken, instruction: "Read back address, window, name and the fee. Never invent a confirmation number." } };
    }
    case "transfer_call": {
      const target = args.target === "office" ? "office" : "on_call";
      if (target === "on_call" && s.area && !s.area.inArea && s.area.method !== "unknown") {
        return { output: { ok: false, reason: "out_of_service_area" } };
      }
      const action = session.requestTransfer(target, String(args.reason ?? ""));
      if (action.type === "none") {
        const mins = s.triage.priority === "P1" ? await session.scheduleEmergencyCallback() : undefined;
        if (s.triage.priority === "P1") await session.alertOnCallBySms();
        else await session.scheduleCallback("transfer_unavailable");
        return { output: { ok: false, reason: action.reason, mustSay: mins ? `I've sent our on-call plumber an urgent alert, and they'll call you back within about ${mins} minutes.` : "I've asked the team to call you back." } };
      }
      return { output: { ok: true, instruction: "Tell the caller you're connecting them now and to stay on the line. Say nothing after that." }, action };
    }
    case "take_message": {
      if (typeof args.name === "string") s.customer.name = args.name;
      const when = await session.scheduleCallback("message", `${String(args.reason ?? "")} | ${session.summary()}`);
      return { output: { ok: true, callbackWhen: when } };
    }
    case "end_call": {
      session.end();
      return { output: { ok: true }, action: { type: "hangup", reason: String(args.reason ?? "end_call") } };
    }
    default:
      return { output: { ok: false, error: `unknown tool ${name}` } };
  }
}

function pickBooleans(args: Record<string, unknown>, keys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) if (typeof args[k] === "boolean") out[k] = args[k] as boolean;
  return out;
}

export { isPriceQuestion };
