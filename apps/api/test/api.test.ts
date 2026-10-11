import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ANSWERS, type ToolDefinition } from "@sb/core";
import { DEMO_BUSINESS_NUMBER, hashPassword } from "@sb/db";
import { computeTwilioSignature, decodeMockAudio, encodeMockAudio, TwilioTelephony, type VoiceProvider, type VoiceSessionOptions } from "@sb/providers";
import { startTestApp, TUE_10AM, type TestApp } from "./harness";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function login(app: TestApp, email: string, password: string): Promise<string> {
  const res = await fetch(`${app.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function api(app: TestApp, token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${app.base}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

describe("dashboard API", () => {
  it("requires auth and rejects bad credentials", async () => {
    t = await startTestApp(TUE_10AM);
    expect((await fetch(`${t.base}/api/tenants`)).status).toBe(401);
    const bad = await fetch(`${t.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@sonicbold.test", password: "nope" }) });
    expect(bad.status).toBe(401);
  });

  it("agency admin onboards a plumber tenant from the template; owners only see their own tenant", async () => {
    t = await startTestApp(TUE_10AM);
    const admin = await login(t, "admin@sonicbold.test", "pw-admin");
    const template = await api(t, admin, "/api/onboarding/template");
    expect(template.json.services.length).toBeGreaterThanOrEqual(5);

    const answers = {
      ...DEMO_ANSWERS,
      brand: { ...DEMO_ANSWERS.brand, companyName: "Bayou City Drain & Sewer", agentName: "Sam" },
      timezone: "America/Chicago",
      serviceArea: { zips: ["77002", "77003"], description: "central Houston" },
    };
    const created = await api(t, admin, "/api/tenants", { method: "POST", body: { answers, phoneNumbers: ["+17135550100"] } });
    expect(created.status).toBe(201);
    expect(created.json.slug).toBe("bayou-city-drain-sewer");
    expect((await api(t, admin, "/api/tenants", { method: "POST", body: { answers, phoneNumbers: ["+17135550100"] } })).status).toBe(409);

    // Owner of the demo tenant cannot read the new tenant.
    const owner = await login(t, "owner@lonestar.test", "pw-owner");
    const list = await api(t, owner, "/api/tenants");
    expect(list.json.map((x: { slug: string }) => x.slug)).toEqual(["lone-star-plumbing"]);
    expect((await api(t, owner, `/api/tenants/${created.json.id}`)).status).toBe(404);
    expect((await api(t, owner, `/api/tenants/${created.json.id}/calls`)).status).toBe(404);
    expect((await api(t, owner, "/api/tenants", { method: "POST", body: { answers } })).status).toBe(403);

    expect((await api(t, owner, `/api/tenants/${t.tenant.id}/status`, { method: "PUT", body: { status: "paused" } })).status).toBe(403);
    const activated = await api(t, admin, `/api/tenants/${created.json.id}/status`, { method: "PUT", body: { status: "active" } });
    expect(activated.json.status).toBe("active");

    // The new number routes calls to the new tenant.
    expect(await t.store.resolveTenantByNumber("+17135550100")).toBe(created.json.id);
  });

  it("validates tenant config updates", async () => {
    t = await startTestApp(TUE_10AM);
    const admin = await login(t, "admin@sonicbold.test", "pw-admin");
    const tenant = (await api(t, admin, `/api/tenants/${t.tenant.id}`)).json;
    const bad = await api(t, admin, `/api/tenants/${t.tenant.id}/config`, { method: "PUT", body: { config: { ...tenant.config, pricing: { ...tenant.config.pricing, tripFee: -5 } } } });
    expect(bad.status).toBe(400);
    expect(bad.json.issues.length).toBeGreaterThan(0);
    const good = await api(t, admin, `/api/tenants/${t.tenant.id}/config`, { method: "PUT", body: { config: { ...tenant.config, pricing: { ...tenant.config.pricing, tripFee: 99 } } } });
    expect(good.status).toBe(200);
    expect(good.json.config.pricing.tripFee).toBe(99);
  });

  it("simulator runs the engine without sending anything", async () => {
    t = await startTestApp(TUE_10AM);
    const token = await login(t, "owner@lonestar.test", "pw-owner");
    const start = await api(t, token, `/api/tenants/${t.tenant.id}/simulate`, { method: "POST", body: {} });
    expect(start.json.say).toMatch(/Thanks for calling/);
    const r = await api(t, token, `/api/tenants/${t.tenant.id}/simulate`, { method: "POST", body: { callId: start.json.callId, text: "I smell gas by the water heater" } });
    expect(r.json.priority).toBe("P0");
    expect(r.json.ended).toBe(true);
    await t.settle();
    expect(t.telephony.sms).toHaveLength(0);
    const alerts = await api(t, token, `/api/tenants/${t.tenant.id}/alerts`);
    expect(alerts.json[0].status).toBe("simulated");
    const detail = await api(t, token, `/api/tenants/${t.tenant.id}/calls/${start.json.callId}`);
    expect(detail.json.transcript.length).toBe(3);
    expect(detail.json.triage.priority).toBe("P0");
  });
});

describe("Twilio webhook security", () => {
  it("rejects unsigned webhooks when using real Twilio and accepts valid signatures", async () => {
    t = await startTestApp(TUE_10AM);
    t.ctx.telephony = new TwilioTelephony("ACtest", "auth-token-test");
    t.ctx.env.TWILIO_VALIDATE_SIGNATURES = true;
    const params = { CallSid: "CAsig", From: "+15125550101", To: DEMO_BUSINESS_NUMBER, CallStatus: "ringing" };
    const url = `${t.base}/twilio/voice/incoming`;
    const unsigned = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
    expect(unsigned.status).toBe(403);
    const signed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": computeTwilioSignature("auth-token-test", url, params) },
      body: new URLSearchParams(params).toString(),
    });
    expect(signed.status).toBe(200);
    expect(await signed.text()).toMatch(/<Stream/);
  });
});

/**
 * A fake "LLM" voice provider that behaves like a model that ignores safety:
 * after the caller mentions gas it still tries to book. The gateway must
 * interrupt with the fixed script and the tools must refuse.
 */
class RecklessModelProvider implements VoiceProvider {
  readonly name = "reckless-model";
  readonly driver = "llm" as const;
  said: Array<{ text: string; interrupt: boolean }> = [];
  toolResults: Array<{ name: string; output: Record<string, unknown> }> = [];
  tools: ToolDefinition[] = [];
  instructions = "";

  async connect(opts: VoiceSessionOptions) {
    const h = opts.handlers;
    this.tools = opts.tools;
    this.instructions = opts.instructions;
    const speak = (text: string) => {
      h.onAgentTranscript(text);
      h.onAudio(encodeMockAudio(text));
      h.onResponseDone();
    };
    queueMicrotask(() => speak(opts.greeting));
    return {
      sendAudio: (payload: string) => {
        const text = decodeMockAudio(payload);
        if (!text) return;
        h.onCallerTranscript(text);
        void (async () => {
          await new Promise((r) => setTimeout(r, 20));
          const call = async (name: string, args: unknown) => this.toolResults.push({ name, output: await h.onToolCall(name, args) });
          await call("record_facts", { issue: "clogged_drain" });
          await call("check_service_area", { zip: "78704" });
          await call("find_availability", {});
          await call("book_appointment", { slotId: "x", name: "Pat Doe", address: "1 Main St", adultPresent: true, smsConsent: false });
          speak("Sure, a repair like that is usually around $250.");
        })();
      },
      say: (text: string, o?: { interrupt?: boolean }) => {
        this.said.push({ text, interrupt: !!o?.interrupt });
        speak(text);
      },
      close: () => h.onClose(),
    };
  }
}

describe("LLM voice driver guardrails", () => {
  it("gas mention interrupts the model with the safety script; tools refuse to book; price guard fires", async () => {
    t = await startTestApp(TUE_10AM);
    const model = new RecklessModelProvider();
    t.ctx.voice = model;
    const d = t.call();
    await d.start();
    expect(model.tools.map((x) => x.name)).toContain("book_appointment");
    expect(model.instructions).toMatch(/never quote/i);
    await d.say("my drain is clogged, and also I smell gas in the laundry room");
    await new Promise((r) => setTimeout(r, 300));
    await t.settle();
    expect(model.said[0]?.interrupt).toBe(true);
    expect(model.said[0]?.text).toMatch(/get everyone out/);
    const booking = model.toolResults.find((r) => r.name === "book_appointment");
    expect(booking?.output.ok).toBe(false);
    expect(await t.store.listBookings(t.tenant.id)).toHaveLength(0);
    const events = await t.store.listEvents(t.tenant.id, d.callId);
    expect(events.some((e) => e.type === "guard.price_violation")).toBe(true);
    await d.end();
  });
});

describe("password hashing", () => {
  it("never stores plaintext", async () => {
    const h = await hashPassword("secret-pass");
    expect(h).not.toContain("secret-pass");
  });
});

describe("channel setup regressions", () => {
  it("saves separate providers and exposes configuration readiness without secrets", async () => {
    t = await startTestApp(TUE_10AM);
    const token = await login(t, "admin@sonicbold.test", "pw-admin");
    t.ctx.env.OPENROUTER_API_KEY = "private-key-never-return";
    const setup = await api(t, token, "/api/setup");
    expect(setup.json.connections.openrouter).toBe(true);
    expect(JSON.stringify(setup.json)).not.toContain("private-key-never-return");
    const updated = await api(t, token, `/api/tenants/${t.tenant.id}/config`, { method: "PUT", body: { config: { ...t.tenant.config, voice: { enabled: true, provider: "deepgram-openrouter", model: "chosen/model" }, sms: { ...t.tenant.config.sms, provider: "openrouter", model: "sms/model" } } } });
    expect(updated.status).toBe(200);
    expect(updated.json.config.voice.model).toBe("chosen/model");
    expect(updated.json.config.sms.model).toBe("sms/model");
  });
  it("ignores ringing status updates instead of ending calls and texting callers", async () => {
    t = await startTestApp(TUE_10AM);
    const { postForm } = await import("../src/dev/callDriver");
    await postForm(`${t.base}/twilio/voice/status`, { To: DEMO_BUSINESS_NUMBER, From: "+15125559876", CallSid: "CA-ringing", CallStatus: "ringing" });
    await t.settle();
    expect(await t.store.getCallBySid(t.tenant.id, "CA-ringing")).toBeNull();
    expect(t.telephony.sms).toHaveLength(0);
  });
  it("disables voice independently and keeps SMS replies working", async () => {
    t = await startTestApp(TUE_10AM, { configure: (tenant) => ({ ...tenant.config, voice: { ...tenant.config.voice, enabled: false } }) });
    const { postForm, inboundSms } = await import("../src/dev/callDriver");
    const call = await postForm(`${t.base}/twilio/voice/incoming`, { To: DEMO_BUSINESS_NUMBER, From: "+15125559876", CallSid: "CA-voice-off" });
    expect(call.text).toContain("<Dial>");
    expect(call.text).not.toContain("<Stream");
    await inboundSms(t.base, "+15125559876", DEMO_BUSINESS_NUMBER, "My drain is clogged");
    await t.settle();
    expect(t.telephony.sms.length).toBeGreaterThan(0);
  });
  it("does not reply to customer messages when SMS is off but still honors STOP", async () => {
    t = await startTestApp(TUE_10AM, { configure: (tenant) => ({ ...tenant.config, sms: { ...tenant.config.sms, enabled: false } }) });
    const { inboundSms } = await import("../src/dev/callDriver");
    await inboundSms(t.base, "+15125559876", DEMO_BUSINESS_NUMBER, "My drain is clogged");
    await t.settle();
    expect(t.telephony.sms).toHaveLength(0);
    expect(await t.store.listCallbacks(t.tenant.id)).toHaveLength(0);
    await inboundSms(t.base, "+15125559876", DEMO_BUSINESS_NUMBER, "STOP");
    await t.settle();
    expect(await t.store.getConsent(t.tenant.id, "+15125559876")).toBe("opted_out");
  });
});


describe("client phone assignment", () => {
  it("allows agency admins to finish phone setup and rejects conflicts and client access", async () => {
    t = await startTestApp(TUE_10AM);
    const token = await login(t, "admin@sonicbold.test", "pw-admin");
    const path = `/api/tenants/${t.tenant.id}/numbers`;
    const assigned = await api(t, token, path, { method: "POST", body: { number: "+15125550999" } });
    expect(assigned.status).toBe(200);
    expect(assigned.json.numbers).toContain("+15125550999");
    expect((await api(t, token, path, { method: "POST", body: { number: "+15125550999" } })).status).toBe(200);
    expect((await api(t, token, path, { method: "POST", body: { number: "123" } })).status).toBe(400);
    const second = await api(t, token, "/api/tenants", { method: "POST", body: { answers: { ...DEMO_ANSWERS, brand: { ...DEMO_ANSWERS.brand, companyName: "Another client" } } } });
    expect((await api(t, token, `/api/tenants/${second.json.id}/numbers`, { method: "POST", body: { number: "+15125550999" } })).status).toBe(409);
    const owner = await login(t, "owner@lonestar.test", "pw-owner");
    expect((await api(t, owner, path, { method: "POST", body: { number: "+15125550998" } })).status).toBe(403);
  });
});


it("transfers a live caller when the voice provider unexpectedly disconnects", async () => {
  t = await startTestApp(TUE_10AM);
  let handlers!: VoiceSessionOptions["handlers"];
  t.ctx.voice = {
    name: "disconnect-test", driver: "llm",
    async connect(opts) {
      handlers = opts.handlers;
      queueMicrotask(() => { handlers.onAudio(encodeMockAudio(opts.greeting)); handlers.onResponseDone(); });
      return { sendAudio: () => undefined, say: () => undefined, close: () => handlers.onClose() };
    },
  };
  const driver = t.call();
  await driver.start();
  handlers.onClose();
  handlers.onError(new Error("duplicate failure notification"));
  await t.settle();
  expect(t.telephony.liveCallUpdates).toHaveLength(1);
  expect(t.telephony.liveCallUpdates[0]?.twiml).toContain("<Dial");
  await driver.end();
});


describe("agency admin panel", () => {
  it("updates every account, preserves client details, and sets defaults for future clients", async () => {
    t = await startTestApp(TUE_10AM);
    const token = await login(t, "admin@sonicbold.test", "pw-admin");
    const created = await api(t, token, "/api/tenants", { method: "POST", body: { answers: { ...DEMO_ANSWERS, brand: { ...DEMO_ANSWERS.brand, companyName: "Second plumbing client" }, pricing: { ...DEMO_ANSWERS.pricing, tripFee: 123 } } } });
    const before = await t.store.listTenants();
    const applied = await api(t, token, "/api/agency/settings", { method: "PUT", body: { settings: { voice: { enabled: true, provider: "deepgram-openrouter", model: "global/model" }, sms: { ...t.tenant.config.sms, enabled: false }, triage: { vulnerableOccupantUpgradesToP1: true, transferP1DuringHours: false } } } });
    expect(applied.status).toBe(200);
    expect(applied.json.updatedAccounts).toBe(2);
    for (const prior of before) {
      const updated = await t.store.getTenant(prior.id);
      expect(updated?.config.voice.model).toBe("global/model");
      expect(updated?.config.sms.enabled).toBe(false);
      expect(updated?.config.brand).toEqual(prior.config.brand);
      expect(updated?.config.pricing).toEqual(prior.config.pricing);
      expect(updated?.config.triage.gasUtilityLine).toBe(prior.config.triage.gasUtilityLine);
      expect(updated?.config.hours).toEqual(prior.config.hours);
    }
    expect((await t.store.getTenant(created.json.id))?.config.pricing.tripFee).toBe(123);
    const read = await api(t, token, "/api/agency/settings");
    expect(read.json.config.voice.model).toBe("global/model");
    const future = await api(t, token, "/api/tenants", { method: "POST", body: { answers: { ...DEMO_ANSWERS, brand: { ...DEMO_ANSWERS.brand, companyName: "Future client" }, voice: { enabled: true, provider: "elevenlabs" } } } });
    expect(future.json.config.voice.provider).toBe("deepgram-openrouter");
    expect(future.json.config.sms.enabled).toBe(false);
    // Applying only recording leaves previously applied voice/SMS settings in place.
    await api(t, token, "/api/agency/settings", { method: "PUT", body: { settings: { recording: { enabled: false, preamble: "Notice" } } } });
    expect((await t.store.getTenant(t.tenant.id))?.config.voice.model).toBe("global/model");
    expect((await t.store.getAgencySettings()).voice?.model).toBe("global/model");
  });
  it("rejects invalid settings and disallowed sections before changing any accounts", async () => {
    t = await startTestApp(TUE_10AM);
    const token = await login(t, "admin@sonicbold.test", "pw-admin");
    const before = await t.store.listTenants();
    for (const settings of [{}, { booking: { capacity: 0 } }, { brand: { companyName: "Overwrite" } }]) {
      expect((await api(t, token, "/api/agency/settings", { method: "PUT", body: { settings } })).status).toBe(400);
      expect(await t.store.listTenants()).toEqual(before);
      expect(await t.store.getAgencySettings()).toEqual({});
    }
  });
  it("limits global changes to the agency owner account", async () => {
    t = await startTestApp(TUE_10AM);
    const owner = await login(t, "owner@lonestar.test", "pw-owner");
    expect((await api(t, owner, "/api/agency/settings")).status).toBe(403);
    expect((await api(t, owner, "/api/agency/settings", { method: "PUT", body: { settings: { voice: { enabled: false, provider: "elevenlabs" } } } })).status).toBe(403);
  });
});
