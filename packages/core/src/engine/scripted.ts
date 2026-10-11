/**
 * ScriptedReceptionist: a deterministic, rule-based dialog policy on top of
 * ReceptionistSession. Used for:
 *   - mock/dev mode (no OpenAI key): the dashboard simulator and mock calls,
 *   - the scripted conversation test suite,
 *   - SMS replies when AI replies are disabled or the model is unavailable.
 *
 * It is intentionally plain-spoken. In real mode the realtime model does the
 * talking and the same session enforces the same rules through tools.
 */
import { extractZip } from "../serviceArea";
import { isPriceQuestion, noQuoteStatement } from "../pricing";
import type { FactQuestionKey } from "../triage/types";
import type { ReceptionistSession} from "./session";
import { yesNo } from "./session";
import type { AgentTurn, RuntimeAction } from "./types";

const HUMAN_RE = /\b(real person|a human|human being|representative|operator|live person|talk to (someone|somebody|a person|the owner|a plumber|a manager)|speak (to|with) (someone|somebody|a person|the owner|a plumber|a manager)|not a robot|no robots?)\b/i;
const DECLINE_RE = /\b(just (wanted|want|need(ed)?|looking for) (a |the )?(price|quote|number|ballpark)|not (right )?now|i'?ll think about it|call(ing)? around|no thanks|no thank you|not interested|never ?mind|i'?ll call back)\b/i;
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|earliest|soonest|first one|the earlier)\b/i, 0],
  [/\b(second|2nd|the later|second one)\b/i, 1],
  [/\b(third|3rd|last one|third one)\b/i, 2],
];

function capitalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[.!?,]+$/, "")
    .split(/\s+/)
    .slice(0, 4)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

const NOT_A_NAME = /^(calling|having|trying|looking|not|in|at|just|so|really|very|a|an|the|my|our|your|about|urgent|an emergency|emergency|regarding|for|with|from|going|getting|still|leaking|clogged|flooding|broken)\b/i;

export function extractName(text: string, expecting: boolean): string | undefined {
  // "I'm"/"it's" are only treated as introductions when we just asked for a name
  // ("it's an emergency" is not a name).
  const intro = expecting ? /\b(?:my name is|my name's|this is|name's|i'm|i am|it's|call me)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i : /\b(?:my name is|my name's|name's|call me|this is)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+){0,2})/i;
  const m = intro.exec(text);
  if (m?.[1] && !NOT_A_NAME.test(m[1])) return capitalizeName(m[1]);
  if (expecting) {
    const words = text.replace(/[^a-zA-Z'\s-]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 4 && !NOT_A_NAME.test(words.join(" "))) return capitalizeName(words.join(" "));
  }
  return undefined;
}

export class ScriptedReceptionist {
  constructor(readonly session: ReceptionistSession) {}

  greeting(): string {
    const c = this.session.config;
    const closed = this.session.state.afterHours ? " Our office is closed right now, but I can still help." : "";
    return `Thanks for calling ${this.session.company}, this is ${c.brand.agentName}, the virtual assistant.${closed} What's going on with your plumbing today?`;
  }

  async respond(text: string): Promise<AgentTurn> {
    const session = this.session;
    const s = session.state;
    if (s.ended) return { say: "", actions: [] };

    const pending = s.pendingQuestion;
    session.observeCaller(text);
    if (session.isLockedForSafety) return session.handleLifeSafety();

    const parts: string[] = [];
    const priceQ = isPriceQuestion(text);
    if (priceQ) s.priceAsks += 1;
    if (HUMAN_RE.test(text)) s.wantsHuman = true;

    // ---- answers to the question we just asked ---------------------------
    if (pending === "name") {
      const name = extractName(text, true);
      if (name) s.customer.name = name;
    } else if (pending === "address") {
      if (text.trim().length >= 5) s.customer.address = text.trim().replace(/[.]$/, "");
    } else if (pending === "adult") {
      const yn = yesNo(text);
      if (yn !== undefined) s.customer.adultPresent = yn;
      else if (/\b(\d{1,2}) ?(years? old|year-old)\b/i.test(text)) s.customer.adultPresent = false;
    } else if (pending === "smsConsent") {
      const yn = yesNo(text);
      s.customer.smsConsent = yn === true;
    } else if (pending === "slot") {
      if (DECLINE_RE.test(text) || (yesNo(text) === false && !ORDINALS.some(([re]) => re.test(text)))) {
        s.declinedVisit = true;
      } else {
        const idx = ORDINALS.find(([re]) => re.test(text))?.[1] ?? matchSlotByTime(text, s.slotsOffered.map((x) => x.spoken)) ?? (yesNo(text) === true ? 0 : undefined);
        const slot = idx !== undefined ? s.slotsOffered[idx] : undefined;
        if (slot) session.chooseSlot(slot.id);
      }
    } else if (pending === "anythingElse") {
      if (yesNo(text) === false || /\b(that'?s (it|all)|bye|thank(s| you))\b/i.test(text)) {
        session.end();
        return this.goodbye();
      }
    } else if (pending === "callbackOk") {
      const yn = yesNo(text);
      if (yn === true) {
        const when = await session.scheduleCallback("routine_callback");
        session.end();
        return { say: `Done — someone from the office will call you back ${when}. Thanks for calling ${session.company}.`, actions: [hangup("callback_scheduled")] };
      }
      if (yn === false) {
        session.end(s.priceAsks > 0 ? "price_only" : "abandoned");
        return this.goodbye("No problem. If you'd like to schedule later, just call or text us back.");
      }
    }
    if (!s.customer.name) {
      const name = extractName(text, false);
      if (name) s.customer.name = name;
    }
    if (DECLINE_RE.test(text) && !s.booking) s.declinedVisit = true;

    // ---- wants a human -----------------------------------------------------
    if (s.wantsHuman && s.triage.priority !== "P1") {
      if (!s.afterHours && session.config.transfer.officeNumber && s.channel === "voice") {
        const action = session.requestTransfer("office", "caller_requested_human");
        if (action.type === "transfer") return { say: "Of course — let me connect you with our office now.", actions: [action] };
      }
      const when = await session.scheduleCallback("message", `Caller asked for a person. ${session.summary()}`);
      session.end("message_taken");
      return { say: `Absolutely. I've put in a callback request for this number, and someone from our team will call you back ${when}.`, actions: [hangup("message_taken")] };
    }

    // ---- what's wrong -------------------------------------------------------
    const issue = s.facts.issue;
    if (issue === "not_offered" || issue === "gas_line_work") {
      session.end("declined_not_offered");
      const what = issue === "gas_line_work" ? "gas line work" : "that kind of work";
      return this.goodbye(`We're a plumbing company, so we don't do ${what} — I'd hate to send someone out who can't fix it. You'll want a specialist for that.`);
    }
    if (issue === "unknown") {
      if (priceQ) {
        parts.push(noQuoteStatement(session.config, undefined, s.priceAsks >= 2));
        s.feeStated = true;
      }
      parts.push(pending === "issue" ? "Could you tell me a bit more about what's happening — is something leaking, clogged, or not working?" : "What's going on with the plumbing?");
      return this.ask(parts, "issue");
    }

    // ---- triage facts (safety first) ---------------------------------------
    const decision = s.triage;
    const open = decision.openQuestions;
    const firstQ = open[0];
    if ((pending === undefined || pending === "issue") && !s.feeStated && !priceQ) {
      parts.push(decision.priority === "P1" ? "Okay, let's get this handled fast." : "Got it, we can help with that.");
    }

    const flowing = s.facts.waterFlowing === true && s.facts.shutoffClosed !== true;
    if (firstQ?.key === "nearElectrical") {
      parts.push(firstQ.prompt);
      return this.ask(parts, "nearElectrical");
    }
    if (flowing && !s.shutoffGuidanceGiven && s.facts.nearElectrical === false && firstQ?.key !== "shutoffLocated") {
      parts.push(session.shutoffGuidance());
    }
    if (priceQ) {
      parts.push(noQuoteStatement(session.config, session.service(), s.priceAsks >= 2));
      s.feeStated = true;
    }
    if (firstQ) {
      // Ask the fee early, but never before a safety question.
      if (!s.feeStated && decision.priority !== "P1") parts.push(session.feeStatement());
      parts.push(firstQ.prompt);
      return this.ask(parts, firstQ.key as FactQuestionKey);
    }
    if (!s.feeStated) parts.push(session.feeStatement());

    // ---- service area ---------------------------------------------------------
    if (!s.area || (!s.area.inArea && s.area.method === "unknown")) {
      const zip = extractZip(text) ?? s.customer.zip ?? (s.customer.address ? extractZip(s.customer.address) : undefined);
      if (zip) await session.checkArea({ zip });
      else if (pending === "zip") {
        parts.push("Sorry, I didn't catch a ZIP code — what's the five-digit ZIP where the problem is?");
        return this.ask(parts, "zip");
      } else {
        parts.push("What's the ZIP code where the problem is?");
        return this.ask(parts, "zip");
      }
    }
    if (s.area && !s.area.inArea) {
      if (s.area.method === "unknown") {
        const when = await session.scheduleCallback("service_area_unverified");
        session.end();
        parts.push(`I couldn't confirm that location is in our service area, so I've asked the office to call you back ${when}.`);
        return { say: parts.join(" "), actions: [hangup("area_unverified")] };
      }
      session.end("out_of_area");
      const where = session.config.serviceArea.description ? ` We cover ${session.config.serviceArea.description}.` : "";
      const urgent = s.triage.priority === "P1" ? " Since this is urgent, please call a local plumber right away" + (flowing ? ", and shut the water off at the main if you can do it safely." : ".") : "";
      parts.push(`I'm sorry — ${s.area.zip ?? "that area"} is outside our service area, so we can't send a plumber there.${where}${urgent}`);
      return this.goodbye(parts.join(" "));
    }

    // ---- emergencies ------------------------------------------------------------
    if (decision.priority === "P1" && (s.afterHours || session.config.triage.transferP1DuringHours || s.wantsHuman)) {
      if (!s.shutoffGuidanceGiven && flowing) parts.push(session.shutoffGuidance());
      if (s.channel === "voice") {
        const action = session.requestTransfer(s.afterHours ? "on_call" : "office", "emergency");
        if (action.type === "transfer") {
          parts.push(s.afterHours ? "I'm connecting you with our on-call plumber right now. Please stay on the line." : "I'm connecting you with our dispatcher right now. Please stay on the line.");
          return { say: parts.join(" "), actions: [action as RuntimeAction] };
        }
      }
      await session.alertOnCallBySms();
      const when = await session.scheduleEmergencyCallback();
      session.end("callback_scheduled");
      parts.push(`I've sent our on-call plumber an urgent alert with your details, and they'll call you at this number within about ${when} minutes. If anything becomes unsafe, leave the house and call 911.`);
      return { say: parts.join(" "), actions: [hangup("emergency_callback")] };
    }

    // ---- booking ----------------------------------------------------------------
    if (s.declinedVisit) {
      session.end(s.priceAsks > 0 ? "price_only" : "abandoned");
      return this.goodbye("No problem at all. If you'd like to get on the schedule, just call or text this number.");
    }
    if (session.config.booking.mode === "request") {
      const when = await session.scheduleCallback("booking_request");
      session.end();
      parts.push(`I've put in a service request, and the office will call you ${when} to lock in a time.`);
      return { say: parts.join(" "), actions: [hangup("booking_request")] };
    }
    if (!s.chosenSlotId) {
      if (s.slotsOffered.length === 0 || pending === "slot") {
        const offer = await session.offerSlots(decision.priority === "P3" ? 3 : 2);
        if (!offer.ok) {
          parts.push("I don't have an opening I can book right now. Would you like the office to call you to find a time?");
          return this.ask(parts, "callbackOk");
        }
        const closed = s.afterHours && pending !== "slot" ? "Our office is closed right now, but I can book your first opening. " : "";
        const list = offer.slots.map((x) => x.spoken);
        const sameDay = decision.priority === "P2" && decision.reasonCodes.includes("CONTEXT:VULNERABLE_OCCUPANT") ? "I'll prioritize you for the soonest opening. " : "";
        parts.push(`${closed}${sameDay}I can have a plumber there ${joinOr(list)}. Which works best?`);
        return this.ask(parts, "slot");
      }
    }
    if (!s.customer.name) {
      parts.push("Great. Can I get your first and last name?");
      return this.ask(parts, "name");
    }
    if (!s.customer.address) {
      parts.push("And the street address where the plumber should go?");
      return this.ask(parts, "address");
    }
    if (session.config.booking.adultRequired && s.customer.adultPresent === undefined) {
      parts.push("Will someone eighteen or older be at the property when the plumber arrives?");
      return this.ask(parts, "adult");
    }
    if (s.customer.smsConsent === undefined && s.channel === "voice") {
      parts.push("Can we text this number your appointment confirmation? Message and data rates may apply, and you can reply STOP to opt out.");
      return this.ask(parts, "smsConsent");
    }
    if (s.channel === "sms" && s.customer.smsConsent === undefined) s.customer.smsConsent = true;

    const booked = await session.book();
    if (!booked.ok) {
      if (booked.reason === "adult_required") {
        s.customer.adultPresent = undefined;
        s.chosenSlotId = undefined;
        s.slotsOffered = [];
        parts.push(booked.say ?? "");
        return this.ask(parts, "callbackOk");
      }
      if (booked.reason === "out_of_service_area") {
        session.end("out_of_area");
        return this.goodbye("I'm sorry — that address is outside our service area, so I can't book it.");
      }
      const when = await session.scheduleCallback("booking_failed", `Booking failed (${booked.reason}). ${session.summary()}`);
      session.end();
      parts.push(`I wasn't able to lock that time in, so I've asked the office to call you ${when} to confirm.`);
      return { say: parts.join(" "), actions: [hangup("booking_failed")] };
    }
    const fee = `$${session.config.pricing.tripFee}`;
    const text2 = s.customer.smsConsent ? " I've texted you a confirmation." : "";
    parts.push(`You're all set: a plumber to ${s.customer.address}, ${booked.spoken}, for ${s.customer.name}. The ${session.config.pricing.tripFeeLabel} is ${fee}, and they'll call when they're on the way.${text2} Is there anything else I can help with?`);
    return this.ask(parts, "anythingElse");
  }

  private ask(parts: string[], q: SessionPendingQuestion): AgentTurn {
    this.session.state.pendingQuestion = q;
    return { say: parts.filter(Boolean).join(" "), actions: [] };
  }

  private goodbye(prefix?: string): AgentTurn {
    this.session.end();
    const bye = `Thanks for calling ${this.session.company}. Take care.`;
    return { say: prefix ? `${prefix} ${bye}` : bye, actions: [hangup("conversation_complete")] };
  }
}

type SessionPendingQuestion = NonNullable<ReceptionistSession["state"]["pendingQuestion"]>;

function hangup(reason: string): RuntimeAction {
  return { type: "hangup", reason };
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** "the 1 o'clock one", "9 am" → index of the offered slot whose spoken form contains it. */
function matchSlotByTime(text: string, spoken: string[]): number | undefined {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?\b/i.exec(text);
  if (!m) return undefined;
  const hour = m[1];
  const idx = spoken.findIndex((sp) => new RegExp(`between ${hour}(:\\d{2})? `, "i").test(sp));
  return idx >= 0 ? idx : undefined;
}
