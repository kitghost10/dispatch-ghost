import WebSocket from "ws";
import type { VoiceProvider, VoiceSession, VoiceSessionOptions } from "./types";

interface Config {
  deepgramApiKey: string;
  openRouterApiKey: string;
  model: string;
  transcriptionModel: string;
  speechModel: string;
  /** Test seams; production always uses the providers' official endpoints. */
  listenUrl?: string;
  fetchImpl?: typeof fetch;
}
type Message = { role: string; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** Deepgram transcribes Twilio mu-law; OpenRouter calls domain tools; Deepgram speaks. */
export class DeepgramOpenRouterProvider implements VoiceProvider {
  readonly name = "deepgram-openrouter";
  readonly driver = "llm" as const;
  constructor(private readonly cfg: Config) {}

  async connect(opts: VoiceSessionOptions): Promise<VoiceSession> {
    const { cfg } = this;
    const h = opts.handlers;
    const request = cfg.fetchImpl ?? fetch;
    const url = new URL(cfg.listenUrl ?? "wss://api.deepgram.com/v1/listen");
    for (const [key, value] of Object.entries({ model: cfg.transcriptionModel, encoding: "mulaw", sample_rate: "8000", channels: "1", interim_results: "true", endpointing: "300", utterance_end_ms: "1000", vad_events: "true", punctuate: "true" })) url.searchParams.set(key, value);
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${cfg.deepgramApiKey}` } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("Deepgram connection timed out")); }, 10_000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (err) => { clearTimeout(timer); reject(err); });
    });
    let closed = false;
    let revision = 0;
    let speech: AbortController | null = null;
    const lifetime = new AbortController();
    let work: Promise<void> = Promise.resolve();
    let transcript: string[] = [];
    const messages: Message[] = [{ role: "system", content: opts.instructions }];
    const fail = (err: unknown) => { if (!closed) h.onError(err instanceof Error ? err : new Error(String(err))); };
    const interrupt = () => { revision++; speech?.abort(); h.onInterrupt(); };
    const speak = async (text: string, version: number) => {
      if (closed || version !== revision || !text.trim()) return;
      speech?.abort();
      const controller = new AbortController();
      speech = controller;
      const speakUrl = new URL("https://api.deepgram.com/v1/speak");
      for (const [key, value] of Object.entries({ model: cfg.speechModel, encoding: "mulaw", sample_rate: "8000", container: "none" })) speakUrl.searchParams.set(key, value);
      try {
        const res = await request(speakUrl.toString(), {
          method: "POST", headers: { Authorization: `Token ${cfg.deepgramApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(15_000)]),
        });
        if (!res.ok) throw new Error(`Deepgram speech ${res.status}`);
        const audio = Buffer.from(await res.arrayBuffer());
        if (closed || version !== revision) return;
        await h.onAgentTranscript(text);
        for (let i = 0; i < audio.length; i += 1600) h.onAudio(audio.subarray(i, i + 1600).toString("base64"));
        h.onResponseDone();
      } catch (err) { if (!controller.signal.aborted && !closed) throw err; }
    };
    const respond = async (text: string, version: number) => {
      // Wait for the gateway's deterministic safety check before asking the model.
      await h.onCallerTranscript(text);
      if (closed || version !== revision) return;
      messages.push({ role: "user", content: text });
      // Preserve tool-call/result groups when bounding conversation history.
      if (messages.length > 60) {
        const cut = messages.findIndex((m, i) => i >= messages.length - 40 && m.role === "user");
        if (cut > 1) messages.splice(1, cut - 1);
      }
      for (let round = 0; round < 6; round++) {
        if (closed || version !== revision) return;
        const res = await request("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST", headers: { Authorization: `Bearer ${cfg.openRouterApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: cfg.model, messages, tools: opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), provider: { require_parameters: true }, temperature: 0.3, max_tokens: 300 }),
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
        });
        if (!res.ok) throw new Error(`OpenRouter conversation ${res.status}`);
        const data = await res.json() as { choices?: { message: { content?: string | null; tool_calls?: ToolCall[] } }[] };
        if (closed || version !== revision) return;
        const answer = data.choices?.[0]?.message;
        if (!answer) throw new Error("OpenRouter returned no reply");
        if (answer.tool_calls?.length) {
          messages.push({ role: "assistant", content: answer.content ?? null, tool_calls: answer.tool_calls });
          for (const call of answer.tool_calls) {
            let args: unknown;
            try { args = JSON.parse(call.function.arguments || "{}"); }
            catch { args = undefined; }
            const output = args === undefined ? { ok: false, error: "invalid_tool_arguments" } : await h.onToolCall(call.function.name, args);
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
          }
          continue;
        }
        const text = opts.filterReply?.(answer.content ?? "") ?? answer.content ?? "";
        if (!text.trim()) throw new Error("OpenRouter returned an empty spoken reply");
        messages.push({ role: "assistant", content: text });
        await speak(text, version);
        return;
      }
      throw new Error("OpenRouter exceeded tool-call limit");
    };
    const flush = () => {
      const text = transcript.join(" ").trim();
      transcript = [];
      if (!text) return;
      const version = revision;
      work = work.then(() => respond(text, version)).catch(fail);
    };
    ws.on("message", (raw) => {
      if (closed) return;
      try {
        const event = JSON.parse(raw.toString()) as { type: string; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
        if (event.type === "SpeechStarted") interrupt();
        if (event.type === "Results") {
          const text = event.channel?.alternatives?.[0]?.transcript?.trim();
          if (event.is_final && text) transcript.push(text);
          if (event.speech_final) flush();
        }
        if (event.type === "UtteranceEnd") flush();
        if (event.type === "Error") fail(new Error("Deepgram transcription error"));
      } catch (err) { fail(err); }
    });
    ws.on("error", fail);
    const keepAlive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 4000);
    ws.on("close", () => { clearInterval(keepAlive); if (!closed) fail(new Error("Deepgram disconnected during the call")); h.onClose(); });
    messages.push({ role: "assistant", content: opts.greeting });
    void speak(opts.greeting, revision).catch(fail);
    return {
      sendAudio: (payload) => { if (!closed && ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(payload, "base64")); },
      say: (text, options) => { if (options?.interrupt !== false) interrupt(); void speak(text, revision).catch(fail); },
      close: () => { if (closed) return; closed = true; clearInterval(keepAlive); lifetime.abort(); speech?.abort(); ws.close(); },
    };
  }
}
