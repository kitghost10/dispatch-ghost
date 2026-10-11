import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  computeTwilioSignature,
  connectStreamTwiml,
  decodeMockAudio,
  dialTwiml,
  encodeMockAudio,
  HousecallProAdapter,
  JobberAdapter,
  MockVoiceProvider,
  OpenAiRealtimeProvider,
  ServiceTitanAdapter,
  signServiceAccountJwt,
  validateTwilioSignature,
  GoogleCalendarProvider,
  type FsmJobInput,
} from "../src";

describe("twilio signature", () => {
  it("validates and rejects tampering", () => {
    const params = { CallSid: "CA123", From: "+15125559876", To: "+15125550199" };
    const url = "https://voice.example.com/twilio/voice/incoming";
    const sig = computeTwilioSignature("secret-token", url, params);
    expect(validateTwilioSignature("secret-token", url, params, sig)).toBe(true);
    expect(validateTwilioSignature("secret-token", url, { ...params, From: "+10000000000" }, sig)).toBe(false);
    expect(validateTwilioSignature("other", url, params, sig)).toBe(false);
    expect(validateTwilioSignature(undefined, url, params, sig)).toBe(false);
  });
});

describe("twiml", () => {
  it("escapes and builds stream + dial", () => {
    const x = connectStreamTwiml({ preamble: "Calls are recorded & reviewed.", streamUrl: "wss://h/media-stream", parameters: { callId: "abc" } });
    expect(x).toContain("Calls are recorded &amp; reviewed.");
    expect(x).toContain('<Parameter name="callId" value="abc"/>');
    const d = dialTwiml({ number: "+15125550111", timeoutSec: 20, action: "https://h/t?x=1&y=2", sayFirst: "Connecting" });
    expect(d).toContain('action="https://h/t?x=1&amp;y=2"');
    expect(d).toContain("<Number>+15125550111</Number>");
  });
});

describe("mock voice", () => {
  it("round-trips text as fake audio", async () => {
    expect(decodeMockAudio(encodeMockAudio("hello"))).toBe("hello");
    const heard: string[] = [];
    const spoken: string[] = [];
    const s = await new MockVoiceProvider().connect({
      instructions: "", tools: [], greeting: "Hi there",
      handlers: { onAudio: () => undefined, onInterrupt: () => undefined, onCallerTranscript: (t) => heard.push(t), onAgentTranscript: (t) => spoken.push(t), onToolCall: async () => ({}), onResponseDone: () => undefined, onError: () => undefined, onClose: () => undefined },
    });
    await Promise.resolve();
    s.sendAudio(encodeMockAudio("my sink is clogged"));
    s.sendAudio(Buffer.from([0xff, 0xff]).toString("base64"));
    expect(heard).toEqual(["my sink is clogged"]);
    expect(spoken).toEqual(["Hi there"]);
  });
});

describe("openai realtime provider", () => {
  it("configures a pcmu session, relays audio/transcripts and answers tool calls", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const received: Array<Record<string, unknown>> = [];
    wss.on("connection", (sock, req) => {
      expect(req.headers.authorization).toBe("Bearer test-key");
      sock.on("message", (raw) => {
        const ev = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(ev);
        if (ev.type === "session.update") {
          sock.send(JSON.stringify({ type: "response.created" }));
          sock.send(JSON.stringify({ type: "response.output_audio.delta", item_id: "item1", delta: Buffer.from("abc").toString("base64") }));
          sock.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "a pipe burst" }));
          sock.send(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call1", name: "record_facts", arguments: '{"issue":"burst_pipe"}' }));
        }
      });
    });
    const audio: string[] = [];
    const heard: string[] = [];
    const toolCalls: Array<[string, unknown]> = [];
    const provider = new OpenAiRealtimeProvider({ apiKey: "test-key", model: "gpt-realtime", voice: "marin", transcriptionModel: "gpt-4o-mini-transcribe", url: `ws://127.0.0.1:${port}` });
    const session = await provider.connect({
      instructions: "be nice", tools: [{ type: "function", name: "record_facts", description: "", parameters: {} }], greeting: "Hello",
      handlers: {
        onAudio: (a) => audio.push(a), onInterrupt: () => undefined, onCallerTranscript: (t) => heard.push(t), onAgentTranscript: () => undefined,
        onToolCall: async (name, args) => { toolCalls.push([name, args]); return { priority: "P1" }; },
        onResponseDone: () => undefined, onError: () => undefined, onClose: () => undefined,
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    session.close();
    wss.close();
    const update = received.find((e) => e.type === "session.update") as { session: { audio: { input: { format: { type: string } }; output: { voice: string } }; tools: unknown[] } };
    expect(update.session.audio.input.format.type).toBe("audio/pcmu");
    expect(update.session.audio.output.voice).toBe("marin");
    expect(update.session.tools).toHaveLength(1);
    expect(audio).toHaveLength(1);
    expect(heard).toEqual(["a pipe burst"]);
    expect(toolCalls).toEqual([["record_facts", { issue: "burst_pipe" }]]);
    const output = received.find((e) => e.type === "conversation.item.create") as { item: { call_id: string; output: string } };
    expect(output.item.call_id).toBe("call1");
    expect(JSON.parse(output.item.output)).toEqual({ priority: "P1" });
  });
});

describe("google calendar", () => {
  it("signs a verifiable service-account JWT and calls freeBusy", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = { client_email: "sa@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const jwt = signServiceAccountJwt(key, "https://www.googleapis.com/auth/calendar", 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s!.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      return new Response(JSON.stringify({ calendars: { cal1: { busy: [{ start: "2026-10-01T15:00:00Z", end: "2026-10-01T16:00:00Z" }] } } }));
    }) as unknown as typeof fetch;
    const g = new GoogleCalendarProvider(key, fakeFetch);
    const busy = await g.busy("cal1", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"));
    expect(busy[0]!.start.toISOString()).toBe("2026-10-01T15:00:00.000Z");
    expect(calls[1]).toContain("/freeBusy");
  });
});

describe("field service adapters", () => {
  const job: FsmJobInput = {
    tenantSettings: { tenantId: "123", bookingProviderId: "9" }, customerName: "Pat Doe", customerPhone: "+15125559876",
    address: "1 Main St, Austin, TX 78704", zip: "78704", problem: "burst pipe", priority: "P1", serviceKey: "emergency_repair",
    start: new Date("2026-10-01T15:00:00Z"), end: new Date("2026-10-01T17:00:00Z"), externalId: "bk_1",
  };
  it("ServiceTitan is off unless flagged", async () => {
    await expect(new ServiceTitanAdapter({ enabled: false, live: false }).createJob(job)).rejects.toThrow(/FSM_SERVICETITAN_ENABLED/);
  });
  it("ServiceTitan dry-run by default", async () => {
    const r = await new ServiceTitanAdapter({ enabled: true, live: false }).createJob(job);
    expect(r).toEqual({ ref: "dry-run:bk_1", dryRun: true, provider: "servicetitan" });
  });
  it("ServiceTitan live posts a booking with auth + app key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).endsWith("/connect/token")) return new Response(JSON.stringify({ access_token: "st", expires_in: 900 }));
      return new Response(JSON.stringify({ id: 555 }));
    }) as unknown as typeof fetch;
    const r = await new ServiceTitanAdapter({ enabled: true, live: true, clientId: "c", clientSecret: "s", appKey: "ak" }, fakeFetch).createJob(job);
    expect(r.ref).toBe("555");
    expect(seen[1]!.url).toBe("https://api.servicetitan.io/crm/v2/tenant/123/booking-provider/9/bookings");
    expect((seen[1]!.init.headers as Record<string, string>)["ST-App-Key"]).toBe("ak");
    const body = JSON.parse(String(seen[1]!.init.body));
    expect(body.priority).toBe("Urgent");
    expect(body.address.zip).toBe("78704");
  });
  it("Housecall Pro dry-run and Jobber stub", async () => {
    expect((await new HousecallProAdapter({ enabled: true, live: false }).createJob(job)).dryRun).toBe(true);
    await expect(new JobberAdapter({ enabled: true }).createJob(job)).rejects.toThrow(/not implemented/);
  });
});
