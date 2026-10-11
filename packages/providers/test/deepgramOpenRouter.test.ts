import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { DeepgramOpenRouterProvider, ElevenLabsConversationalProvider, configureElevenLabsAgent, type VoiceSession } from "../src";

let server: WebSocketServer | undefined;
let session: VoiceSession | undefined;
afterEach(async () => { session?.close(); server?.clients.forEach((s) => s.terminate()); await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()); server = undefined; session = undefined; });

async function connect(fetchImpl: typeof fetch, options: { filterReply?: (text: string) => string } = {}) {
  server = new WebSocketServer({ port: 0 });
  const peer = new Promise<WebSocket>((resolve) => server!.once("connection", (sock, req) => {
    expect(req.headers.authorization).toBe("Token dg-test");
    expect(req.url).toContain("encoding=mulaw");
    expect(req.url).toContain("sample_rate=8000");
    resolve(sock);
  }));
  const handlers = { onAudio: vi.fn(), onCallerTranscript: vi.fn(), onAgentTranscript: vi.fn(), onInterrupt: vi.fn(), onToolCall: vi.fn(async () => ({ ok: true })), onResponseDone: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
  session = await new DeepgramOpenRouterProvider({ deepgramApiKey: "dg-test", openRouterApiKey: "or-test", model: "chosen/model", transcriptionModel: "nova-3", speechModel: "aura-2-thalia-en", listenUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, fetchImpl }).connect({ instructions: "Business rules", greeting: "Hello", tools: [{ type: "function", name: "record_facts", description: "Record facts", parameters: { type: "object" } }], handlers, ...options });
  const sock = await peer;
  return { sock, handlers };
}
function utterance(sock: WebSocket) { sock.send(JSON.stringify({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "My sink is clogged" }] } })); }

describe("Deepgram + OpenRouter", () => {
  it("uses the selected model, executes tools and speaks filtered raw mu-law", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let rounds = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (String(url).includes("/speak")) { expect(String(url)).toContain("container=none"); return new Response(new Uint8Array([255, 254, 253])); }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer or-test");
      return new Response(JSON.stringify({ choices: [{ message: rounds++ === 0 ? { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "record_facts", arguments: '{"issue":"clogged_drain"}' } }] } : { content: "Repair costs $999." } }] }));
    }) as typeof fetch;
    const { sock, handlers } = await connect(fetchImpl, { filterReply: () => "The technician will quote the repair." });
    utterance(sock);
    await vi.waitFor(() => expect(handlers.onResponseDone).toHaveBeenCalledTimes(2));
    expect(handlers.onCallerTranscript).toHaveBeenCalledWith("My sink is clogged");
    expect(handlers.onToolCall).toHaveBeenCalledWith("record_facts", { issue: "clogged_drain" });
    expect(bodies.filter((b) => b.model).every((b) => b.model === "chosen/model")).toBe(true);
    expect(bodies.at(-1)).toEqual({ text: "The technician will quote the repair." });
    expect(handlers.onAudio.mock.calls.at(-1)?.[0]).toBe(Buffer.from([255, 254, 253]).toString("base64"));
    expect(handlers.onError).not.toHaveBeenCalled();
  });
  it("reports provider failures so the gateway can transfer to a human", async () => {
    const { sock, handlers } = await connect((async (url) => String(url).includes("/speak") ? new Response(new Uint8Array([255])) : new Response("", { status: 401 })) as typeof fetch);
    utterance(sock);
    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalled());
    expect(handlers.onError.mock.calls[0]?.[0].message).toContain("401");
  });
  it("discards stale audio when a caller interrupts synthesis", async () => {
    let release!: (res: Response) => void;
    let speechRequests = 0;
    const { sock, handlers } = await connect((async (url) => {
      if (String(url).includes("/speak")) {
        speechRequests++;
        if (speechRequests > 1) return new Promise<Response>((resolve) => { release = resolve; });
        return new Response(new Uint8Array([255]));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "A reply" } }] }));
    }) as typeof fetch);
    utterance(sock);
    await vi.waitFor(() => expect(speechRequests).toBe(2));
    sock.send(JSON.stringify({ type: "SpeechStarted" }));
    await vi.waitFor(() => expect(handlers.onInterrupt).toHaveBeenCalled());
    release(new Response(new Uint8Array([254])));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handlers.onAudio).toHaveBeenCalledTimes(1);
  });
});

it("keeps ElevenLabs configured for phone audio and receptionist tools", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  await configureElevenLabsAgent({ apiKey: "el-test", agentId: "primary", voiceId: "voice", fetchImpl: (async (url, init) => {
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(init?.method === "POST" ? { id: "tool1" } : { tools: [] }));
  }) as typeof fetch }, [{ type: "function", name: "record_facts", description: "Facts", parameters: {} }]);
  expect(new ElevenLabsConversationalProvider({ apiKey: "el-test", agentId: "primary", voiceId: "voice" }).name).toBe("elevenlabs");
  expect(JSON.stringify(calls.at(-1)?.body)).toContain("ulaw_8000");
  expect(JSON.stringify(calls.at(-1)?.body)).toContain("tool1");
});
