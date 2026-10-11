/**
 * Scripted end-to-end conversations over the real Twilio webhook + Media
 * Stream path (mock voice provider, mock telephony, in-memory store). No
 * phone lines or API keys needed. Clock is fixed per scenario.
 */
import { afterEach, describe, expect, it } from "vitest";
import { findUnapprovedPrices } from "@sb/core";
import { DEMO_BUSINESS_NUMBER } from "@sb/db";
import { inboundSms, missedCall, parseSay } from "../src/dev/callDriver";
import { callRecord, liveUpdate, smsTo, startTestApp, TUE_10AM, TUE_1130PM, type TestApp } from "./harness";

const ONCALL_1 = "+15125550111";
const ONCALL_2 = "+15125550112";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function expectNoRepairPrices(app: TestApp, lines: string[]) {
  for (const line of lines) expect(findUnapprovedPrices(line, app.tenant.config), line).toEqual([]);
}

describe("life safety (P0): never book, evacuate, alert on-call", () => {
  it("burst pipe near the electrical panel", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    const greeting = await d.start();
    expect(greeting).toMatch(/Thanks for calling Lone Star/);
    expect(greeting).toMatch(/virtual assistant/); // AI disclosure
    const reply = await d.say("A pipe burst in the garage and water is spraying all over the electrical panel!");
    expect(reply).toMatch(/Water near electrical is dangerous/);
    expect(reply).toMatch(/911/);
    await t.settle();
    expect(liveUpdate(t, d.callSid)?.hangup).toBe(true);
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call.priority).toBe("P0");
    expect(call.safetyFlags).toContain("water_near_electrical");
    expect(call.outcome).toBe("safety_evacuate");
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
    const alerts = await t.store.listAlerts(t.tenant.id);
    expect(alerts[0]).toMatchObject({ priority: "P0", reason: "life_safety" });
    expect(t.telephony.sms.some((m) => /LIFE SAFETY/.test(m.body))).toBe(true);
    const callbacks = await t.store.listCallbacks(t.tenant.id);
    expect(callbacks[0]?.priority).toBe("P0");
    // A P0 call is never "missed": no text-back.
    expect(await t.store.listMissedCallTexts(t.tenant.id)).toHaveLength(0);
  });

  it("gas smell: evacuate, 911 + gas utility, no booking even if the caller insists", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    const reply = await d.say("I smell gas in the kitchen, kind of like rotten eggs. Can you send someone to look at the stove line?");
    expect(reply).toMatch(/get everyone out/);
    expect(reply).toMatch(/gas company/);
    expect(reply).toMatch(/Don't flip any light switches/);
    await t.settle();
    expect(liveUpdate(t, d.callSid)?.hangup).toBe(true);
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call.priority).toBe("P0");
    expect(call.safetyFlags).toContain("gas_odor");
    expect(call.reasonCodes.some((r) => r.startsWith("SAFETY_FLAG:GAS"))).toBe(true);
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
  });

  it("negated hazards do not trigger P0 ('no gas smell')", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    const reply = await d.say("my water heater is making a popping noise, no gas smell or anything");
    expect(reply).not.toMatch(/get everyone out/);
    await d.end();
    await t.settle();
    expect((await callRecord(t, d.callId)).priority).not.toBe("P0");
  });
});

describe("priority by facts, not by the caller's word", () => {
  it("no hot water with an infant: P2, prioritized same-day slot, booked", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    const lines: string[] = [];
    lines.push(await d.say("Our water heater quit, there's no hot water at all and we have a newborn baby at home"));
    for (const answer of ["no, no gas smell", "no, it's not leaking", "78745"]) {
      const r = await d.say(answer);
      lines.push(r);
      if (/Which works best/.test(r)) break;
    }
    const offer = lines.at(-1)!;
    expect(offer).toMatch(/soonest opening/);
    expect(offer).toMatch(/today/i);
    expect(lines.join(" ")).toMatch(/\$89/); // trip fee stated early
    for (const answer of ["the first one", "Priya Shah", "4200 Brodie Lane, Austin 78745", "yes", "yes"]) lines.push(await d.say(answer));
    expect(lines.at(-1)).toMatch(/You're all set/);
    await d.say("no that's all, thanks");
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call.priority).toBe("P2");
    expect(call.reasonCodes).toContain("CONTEXT:VULNERABLE_OCCUPANT");
    const [booking] = await t.store.listBookings(t.tenant.id);
    expect(booking).toMatchObject({ priority: "P2", customerName: "Priya Shah", zip: "78745" });
    expect(booking!.startsAt.slice(0, 10)).toBe("2026-09-29"); // same day
    expect(smsTo(t, "+15125559876").some((m) => /You're booked/.test(m.body))).toBe(true);
    expectNoRepairPrices(t, d.agent);
  });

  it("clogged drain: routine P3, fee stated, booked with arrival window, confirmation text", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    const r1 = await d.say("Hi, my kitchen sink is clogged and won't drain. It's an emergency!");
    expect(r1).toMatch(/\$89/);
    const answers = ["no, it's just the kitchen sink", "78704", "the first one", "Maria Lopez", "1402 South Congress Avenue 78704", "yes", "yes please"];
    const replies: string[] = [];
    for (const a of answers) replies.push(await d.say(a));
    expect(replies.at(-1)).toMatch(/You're all set/);
    expect(replies.at(-1)).toMatch(/between/); // arrival window
    await d.say("that's it");
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call.priority).toBe("P3"); // "emergency!" alone doesn't escalate
    expect(call.outcome).toBe("booked");
    const [booking] = await t.store.listBookings(t.tenant.id);
    expect(booking).toMatchObject({ serviceKey: "drain_cleaning", priority: "P3", customerName: "Maria Lopez" });
    const mins = (new Date(booking!.endsAt).getTime() - new Date(booking!.startsAt).getTime()) / 60000;
    expect(mins).toBe(t.tenant.config.services.find((s) => s.key === "drain_cleaning")!.durationMin);
    expect(smsTo(t, "+15125559876").some((m) => /Lone Star/.test(m.body))).toBe(true);
    expectNoRepairPrices(t, d.agent);
  });

  it("price shopper: states the trip fee, never quotes a repair price", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    const r1 = await d.say("How much do you charge to replace a toilet?");
    const r2 = await d.say("it's the upstairs toilet, it rocks and leaks at the base a little. Just give me a ballpark");
    const r3 = await d.say("come on, how much roughly? I'm just calling around for a price");
    const all = [r1, r2, r3].join(" ");
    expect(all).toMatch(/\$89/);
    expect(all).toMatch(/exact price|on site|before any work/i);
    expectNoRepairPrices(t, d.agent);
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(["price_only", "in_progress", "abandoned"]).toContain(call.outcome);
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
  });

  it("out-of-area caller is declined before any booking", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call();
    await d.start();
    await d.say("My toilet is clogged");
    await d.say("just the one toilet");
    const r = await d.say("I'm in Fort Worth, 76101");
    expect(r).toMatch(/outside our service area/);
    await t.settle();
    expect(liveUpdate(t, d.callSid)?.hangup).toBe(true);
    await d.end();
    await t.settle();
    expect((await callRecord(t, d.callId)).outcome).toBe("out_of_area");
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
  });
});

describe("after hours", () => {
  it("emergency: shut-off guidance, then live transfer to the on-call plumber with a whisper", async () => {
    t = await startTestApp(TUE_1130PM);
    const d = t.call();
    const greeting = await d.start();
    expect(greeting).toMatch(/closed right now/);
    const replies: string[] = [];
    for (const a of ["A pipe burst under the kitchen sink and water is spraying everywhere", "no, nowhere near any outlets or the panel", "yes it's still spraying", "I don't know where the shut off is", "78702"]) {
      replies.push(await d.say(a));
      if (/connecting you/.test(replies.at(-1)!)) break;
    }
    const all = replies.join(" ");
    expect(all).toMatch(/clockwise/); // shut-off guidance
    expect(all).toMatch(/\$149/); // after-hours fee
    expect(replies.at(-1)).toMatch(/on-call plumber/);
    await t.settle();
    const up = liveUpdate(t, d.callSid);
    expect(up?.dial?.number).toBe(ONCALL_1);
    expect(up?.twiml).toMatch(/whisper/);
    const whisper = await fetch(`${t.base}/twilio/voice/whisper?${new URL(up!.twiml.match(/url="([^"]+)"/)![1]!.replaceAll("&amp;", "&")).searchParams}`, { method: "POST" });
    expect(await whisper.text()).toMatch(/Transfer from your A I receptionist/);
    await d.stopStream();
    const final = await d.dialResult(up!.dial!.action, "completed");
    expect(final).not.toMatch(/Hangup/);
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call).toMatchObject({ priority: "P1", outcome: "transferred", transferStatus: "connected", afterHours: true });
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
  });

  it("routine: no transfer, booked into the next business-day window", async () => {
    t = await startTestApp(TUE_1130PM);
    const d = t.call();
    await d.start();
    const replies: string[] = [];
    for (const a of ["my bathroom faucet has been dripping for a week", "78704"]) replies.push(await d.say(a));
    expect(replies.at(-1)).toMatch(/Which works best/);
    for (const a of ["the first one", "James Carter", "77 Barton Springs Road 78704", "yes", "no"]) replies.push(await d.say(a));
    expect(replies.at(-1)).toMatch(/You're all set/);
    await d.say("no thanks");
    await d.end();
    await t.settle();
    expect(liveUpdate(t, d.callSid)?.dial).toBeFalsy();
    const [booking] = await t.store.listBookings(t.tenant.id);
    expect(booking?.priority).toBe("P3");
    expect(booking!.startsAt.slice(0, 10)).toBe("2026-09-30"); // Wednesday (local)
    // No SMS consent => no confirmation text.
    expect(smsTo(t, "+15125559876")).toHaveLength(0);
  });

  it("transfer failure: walks the rota, then texts on-call and creates an urgent callback", async () => {
    t = await startTestApp(TUE_1130PM);
    const d = t.call("+15125554321");
    await d.start();
    for (const a of ["sewage is backing up out of the basement floor drain", "no electrical nearby", "yes it's still coming up", "78703"]) {
      const r = await d.say(a);
      if (/connecting you/.test(r)) break;
    }
    await t.settle();
    const first = liveUpdate(t, d.callSid)!;
    expect(first.dial?.number).toBe(ONCALL_1);
    await d.stopStream();
    const second = await d.dialResult(first.dial!.action, "no-answer");
    expect(second).toMatch(new RegExp(ONCALL_2.replace("+", "\\+")));
    const { parseDial } = await import("../src/dev/callDriver");
    const finalTwiml = await d.dialResult(parseDial(second)!.action, "busy");
    const said = parseSay(finalTwiml).join(" ");
    expect(said).toMatch(/urgent text/);
    expect(said).toMatch(/call you back/);
    expect(finalTwiml).toMatch(/<Hangup\/>/);
    await d.end();
    await t.settle();
    const call = await callRecord(t, d.callId);
    expect(call).toMatchObject({ outcome: "transfer_failed_callback", transferStatus: "failed", priority: "P1" });
    for (const n of [ONCALL_1, ONCALL_2]) expect(smsTo(t, n).some((m) => /MISSED TRANSFER/.test(m.body) && m.body.includes("+15125554321"))).toBe(true);
    const [cb] = await t.store.listCallbacks(t.tenant.id, { status: "open" });
    expect(cb).toMatchObject({ priority: "P1", reason: "transfer_failed", callerPhone: "+15125554321" });
    expect(new Date(cb!.dueAt).getTime() - TUE_1130PM.getTime()).toBeLessThanOrEqual(15 * 60_000);

    // Nobody called back within the SLA: the sweep re-alerts on-call + fallback + office once.
    const { sweepOverdueCallbacks } = await import("../src/jobs");
    expect(await sweepOverdueCallbacks(t.ctx)).toBe(0);
    t.clock.now = new Date(TUE_1130PM.getTime() + 30 * 60_000);
    expect(await sweepOverdueCallbacks(t.ctx)).toBe(1);
    expect(await sweepOverdueCallbacks(t.ctx)).toBe(0);
    await t.settle();
    for (const n of [ONCALL_1, "+15125550113", "+15125550100"]) expect(smsTo(t, n).some((m) => /OVERDUE P1 CALLBACK/.test(m.body))).toBe(true);
  });
});

describe("missed calls and SMS", () => {
  it("missed-call text-back, AI SMS reply, HELP and STOP honoured", async () => {
    t = await startTestApp(TUE_10AM);
    const caller = "+15125550188";
    await missedCall(t.base, caller, DEMO_BUSINESS_NUMBER, "no-answer");
    await t.settle();
    const [text] = smsTo(t, caller);
    expect(text?.body).toMatch(/Lone Star Rapid Plumbing/);
    expect(text?.body).toMatch(/STOP/);
    expect((await t.store.listMissedCallTexts(t.tenant.id))[0]).toMatchObject({ status: "sent", phone: caller });

    await inboundSms(t.base, caller, DEMO_BUSINESS_NUMBER, "hi yes, my kitchen drain is clogged");
    await t.settle();
    const reply = smsTo(t, caller).at(-1)!;
    expect(reply.body).toMatch(/\$89|ZIP|drain/i);
    expectNoRepairPrices(t, smsTo(t, caller).map((m) => m.body));

    await inboundSms(t.base, caller, DEMO_BUSINESS_NUMBER, "HELP");
    await t.settle();
    expect(smsTo(t, caller).at(-1)!.body).toMatch(/STOP/);

    await inboundSms(t.base, caller, DEMO_BUSINESS_NUMBER, "STOP");
    await t.settle();
    const count = smsTo(t, caller).length;
    expect(smsTo(t, caller).at(-1)!.body).toMatch(/unsubscribed|won't receive|opted out/i);
    expect(await t.store.getConsent(t.tenant.id, caller)).toBe("opted_out");

    // Opted out: further texts and missed-call text-backs are suppressed.
    await inboundSms(t.base, caller, DEMO_BUSINESS_NUMBER, "are you there?");
    t.clock.now = new Date(TUE_10AM.getTime() + 24 * 3600_000);
    await missedCall(t.base, caller, DEMO_BUSINESS_NUMBER, "busy");
    await t.settle();
    expect(smsTo(t, caller)).toHaveLength(count);
    expect((await t.store.listMissedCallTexts(t.tenant.id))[0]).toMatchObject({ status: "skipped", reason: "opted_out" });
  });

  it("no duplicate text-back within 12 hours", async () => {
    t = await startTestApp(TUE_10AM);
    await missedCall(t.base, "+15125550189", DEMO_BUSINESS_NUMBER);
    await missedCall(t.base, "+15125550189", DEMO_BUSINESS_NUMBER);
    await t.settle();
    expect(smsTo(t, "+15125550189")).toHaveLength(1);
  });

  it("an emergency by text alerts on-call immediately", async () => {
    t = await startTestApp(TUE_1130PM);
    const caller = "+15125550190";
    for (const body of ["water heater burst and water is pouring into the garage", "no electrical anywhere near it", "yes still pouring", "no I can't find the valve", "78702"]) {
      await inboundSms(t.base, caller, DEMO_BUSINESS_NUMBER, body);
      await t.settle();
    }
    expect(smsTo(t, ONCALL_1).length + smsTo(t, ONCALL_2).length).toBeGreaterThan(0);
    const cbs = await t.store.listCallbacks(t.tenant.id);
    expect(cbs[0]?.priority).toBe("P1");
  });

  it("caller hangs up mid-conversation: abandoned-call text-back", async () => {
    t = await startTestApp(TUE_10AM);
    const d = t.call("+15125550191");
    await d.start();
    await d.say("my toilet is running constantly");
    await d.end("completed", 20);
    await t.settle();
    expect(smsTo(t, "+15125550191")).toHaveLength(1);
  });
});

describe("gateway behaviour", () => {
  it("speaks the recording-consent preamble when recording is enabled and starts recording", async () => {
    t = await startTestApp(TUE_10AM, {
      configure: (tn) => ({ ...tn.config, recording: { enabled: true, preamble: "This call may be recorded for quality and training." } }),
    });
    const d = t.call();
    await d.start();
    expect(d.preamble).toBe("This call may be recorded for quality and training.");
    await t.settle();
    expect(t.telephony.recordings).toContain(d.callSid);
    await d.end();
  });

  it("unknown number and bad stream token are rejected", async () => {
    t = await startTestApp(TUE_10AM);
    const res = await fetch(`${t.base}/twilio/voice/incoming`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "CallSid=CA1&From=%2B15125550000&To=%2B19995550000" });
    expect(await res.text()).toMatch(/not in service/);
    const bad = await fetch(`${t.base}/twilio/voice/transfer-result?tenantId=${t.tenant.id}&callId=x&sig=nope`, { method: "POST" });
    expect(bad.status).toBe(403);
  });

  it("voice provider outage falls back to a human transfer", async () => {
    t = await startTestApp(TUE_10AM);
    t.ctx.voice = { name: "broken", driver: "llm", connect: async () => Promise.reject(new Error("upstream down")) };
    const d = t.call();
    await d.start().catch(() => "");
    await t.settle();
    const up = liveUpdate(t, d.callSid);
    expect(up?.dial?.number).toBe(t.tenant.config.transfer.officeNumber);
    await d.end();
  });
});
