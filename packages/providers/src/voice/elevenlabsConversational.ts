/**
 * ElevenLabs Agents (Conversational AI) over WebSocket, bridged to Twilio
 * Media Streams. Twilio and ElevenLabs both speak mu-law 8 kHz (`ulaw_8000`).
 *
 * The agent on the ElevenLabs side is configured (once per process) with our
 * receptionist client tools, ulaw audio, and prompt/first-message overrides.
 * Each call then sends the tenant instructions and greeting. Safety scripts
 * use the TTS REST API so we can interrupt the model with a verbatim line.
 */
import WebSocket from "ws";
import type { ToolDefinition } from "@sb/core";
import type { VoiceProvider, VoiceSession, VoiceSessionOptions } from "./types";

export const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
export const ELEVENLABS_DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

export interface ElevenLabsConversationalConfig {
  apiKey: string;
  agentId: string;
  voiceId: string;
  ttsModel?: string;
  apiBase?: string;
  /** Test hook: skip signed-url fetch and connect here. */
  url?: string;
  fetchImpl?: typeof fetch;
  /** When false (or when `url` is set), do not PATCH the ElevenLabs agent. */
  configureAgent?: boolean;
}

const MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_API = "https://api.elevenlabs.io";

type Json = Record<string, unknown>;

function apiBase(cfg: ElevenLabsConversationalConfig): string {
  return (cfg.apiBase ?? DEFAULT_API).replace(/\/$/, "");
}

async function elFetch(cfg: ElevenLabsConversationalConfig, path: string, init?: RequestInit): Promise<Response> {
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${apiBase(cfg)}${path}`, {
    ...init,
    headers: {
      "xi-api-key": cfg.apiKey,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${init?.method ?? "GET"} ${path} ${res.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
  }
  return res;
}

export function clientToolConfig(tool: ToolDefinition): Json {
  return {
    type: "client",
    name: tool.name,
    description: tool.description,
    expects_response: true,
    parameters: tool.parameters,
  };
}

/** Ensure the ElevenLabs agent has ulaw audio, our client tools, and prompt overrides. */
export async function configureElevenLabsAgent(cfg: ElevenLabsConversationalConfig, tools: ToolDefinition[]): Promise<void> {
  const listed = (await elFetch(cfg, "/v1/convai/tools").then((r) => r.json())) as { tools?: Array<{ id?: string; tool_config?: { name?: string } }> } | Array<{ id?: string; tool_config?: { name?: string } }>;
  const existing = Array.isArray(listed) ? listed : (listed.tools ?? []);
  const byName = new Map<string, string>();
  for (const t of existing) {
    const name = t.tool_config?.name;
    if (name && t.id) byName.set(name, t.id);
  }
  const toolIds: string[] = [];
  for (const tool of tools) {
    let id = byName.get(tool.name);
    if (!id) {
      const created = (await elFetch(cfg, "/v1/convai/tools", { method: "POST", body: JSON.stringify({ tool_config: clientToolConfig(tool) }) }).then((r) => r.json())) as { id?: string };
      if (!created.id) throw new Error(`ElevenLabs tool create returned no id for ${tool.name}`);
      id = created.id;
    }
    toolIds.push(id);
  }
  await elFetch(cfg, `/v1/convai/agents/${encodeURIComponent(cfg.agentId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      conversation_config: {
        asr: { user_input_audio_format: "ulaw_8000" },
        tts: {
          voice_id: cfg.voiceId,
          model_id: cfg.ttsModel ?? ELEVENLABS_DEFAULT_TTS_MODEL,
          agent_output_audio_format: "ulaw_8000",
        },
        agent: { prompt: { tool_ids: toolIds } },
      },
      platform_settings: {
        overrides: {
          conversation_config_override: {
            agent: { first_message: true, language: true, prompt: { prompt: true } },
            tts: { voice_id: true },
          },
        },
      },
    }),
  });
}

export class ElevenLabsConversationalProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  readonly driver = "llm" as const;
  private configuring: Promise<void> | null = null;

  constructor(private readonly cfg: ElevenLabsConversationalConfig) {}

  private ensureConfigured(tools: ToolDefinition[]): Promise<void> {
    if (this.cfg.configureAgent === false || this.cfg.url) return Promise.resolve();
    this.configuring ??= configureElevenLabsAgent(this.cfg, tools);
    return this.configuring;
  }

  private async signedUrl(): Promise<string> {
    const json = (await elFetch(this.cfg, `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(this.cfg.agentId)}`).then((r) => r.json())) as { signed_url?: string };
    if (!json.signed_url) throw new Error("ElevenLabs signed URL missing");
    return json.signed_url;
  }

  async connect(opts: VoiceSessionOptions): Promise<VoiceSession> {
    await this.ensureConfigured(opts.tools);
    const url = this.cfg.url ?? (await this.signedUrl());
    const ws = new WebSocket(url, { headers: { "xi-api-key": this.cfg.apiKey }, maxPayload: MAX_FRAME_BYTES });
    const h = opts.handlers;
    let ignoreAgentAudio = false;
    let closed = false;

    const send = (event: Json) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ElevenLabs conversation connect timeout")), 10_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    send({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: {
          prompt: { prompt: opts.instructions },
          first_message: opts.greeting,
          language: "en",
        },
        tts: { voice_id: this.cfg.voiceId, agent_output_audio_format: "ulaw_8000" },
        asr: { user_input_audio_format: "ulaw_8000" },
      },
    });

    const handleTool = (call: Json) => {
      const name = String(call.tool_name ?? "");
      const callId = String(call.tool_call_id ?? "");
      let args: unknown = call.parameters ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      void h
        .onToolCall(name, args)
        .then((output) => {
          if (call.expects_response === false) return;
          send({ type: "client_tool_result", tool_call_id: callId, result: JSON.stringify(output), is_error: false });
        })
        .catch((err: unknown) => {
          send({
            type: "client_tool_result",
            tool_call_id: callId,
            result: err instanceof Error ? err.message : String(err),
            is_error: true,
          });
        });
    };

    ws.on("message", (raw) => {
      let ev: Json;
      try {
        ev = JSON.parse(raw.toString()) as Json;
      } catch {
        return;
      }
      switch (ev.type) {
        case "ping": {
          const ping = ev.ping_event as { event_id?: number; ping_ms?: number } | undefined;
          const delay = typeof ping?.ping_ms === "number" ? ping.ping_ms : 0;
          const eventId = ping?.event_id;
          setTimeout(() => send({ type: "pong", event_id: eventId }), delay);
          break;
        }
        case "audio": {
          if (ignoreAgentAudio) break;
          const audio = ev.audio_event as { audio_base_64?: string } | undefined;
          if (typeof audio?.audio_base_64 === "string") h.onAudio(audio.audio_base_64);
          break;
        }
        case "user_transcript": {
          const t = (ev.user_transcription_event as { user_transcript?: string } | undefined)?.user_transcript;
          if (typeof t === "string" && t.trim()) h.onCallerTranscript(t.trim());
          break;
        }
        case "agent_response": {
          const t = (ev.agent_response_event as { agent_response?: string } | undefined)?.agent_response;
          if (typeof t === "string" && t.trim()) h.onAgentTranscript(t.trim());
          break;
        }
        case "agent_response_complete":
          if (!ignoreAgentAudio) h.onResponseDone();
          break;
        case "interruption":
          h.onInterrupt();
          break;
        case "client_tool_call":
          handleTool((ev.client_tool_call as Json | undefined) ?? {});
          break;
        case "error": {
          const err = ev.error as { message?: string } | undefined;
          h.onError(new Error(`ElevenLabs: ${err?.message ?? JSON.stringify(ev)}`));
          break;
        }
      }
    });
    ws.on("close", () => {
      if (!closed) h.onClose();
    });
    ws.on("error", (err) => h.onError(err));

    const ttsSay = async (text: string) => {
      const res = await elFetch(this.cfg, `/v1/text-to-speech/${encodeURIComponent(this.cfg.voiceId)}?output_format=ulaw_8000`, {
        method: "POST",
        headers: { Accept: "application/octet-stream" },
        body: JSON.stringify({ text, model_id: this.cfg.ttsModel ?? ELEVENLABS_DEFAULT_TTS_MODEL }),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length) h.onAudio(buf.toString("base64"));
    };

    return {
      sendAudio(payload: string) {
        send({ user_audio_chunk: payload });
      },
      say(text: string, sayOpts?: { interrupt?: boolean }) {
        if (sayOpts?.interrupt !== false) {
          ignoreAgentAudio = true;
          h.onInterrupt();
        }
        void ttsSay(text)
          .catch((err: unknown) => h.onError(err instanceof Error ? err : new Error(String(err))))
          .finally(() => {
            h.onAgentTranscript(text);
            send({
              type: "contextual_update",
              text: `You already said this verbatim to the caller and must not repeat it: "${text.replace(/"/g, "'")}". Continue from there.`,
            });
            ignoreAgentAudio = false;
            h.onResponseDone();
          });
      },
      close() {
        closed = true;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  }
}
