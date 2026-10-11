/**
 * OpenAI Realtime API (GA) over WebSocket, bridged to Twilio Media Streams.
 *
 * Session shape and event names follow LobbyStack's voice gateway at commit
 * e88a20c (apps/voice-gateway/src/telephony/mediaStream.ts, MIT): mu-law in
 * and out (`audio/pcmu`), server VAD, input transcription, function tools,
 * barge-in via input_audio_buffer.speech_started + conversation.item.truncate.
 */
import WebSocket from "ws";
import type { VoiceProvider, VoiceSession, VoiceSessionOptions } from "./types";

export interface OpenAiRealtimeConfig {
  apiKey: string;
  model: string;
  voice: string;
  transcriptionModel: string;
  url?: string;
  vadSilenceMs?: number;
}

const MAX_FRAME_BYTES = 256 * 1024;

export class OpenAiRealtimeProvider implements VoiceProvider {
  readonly name = "openai-realtime";
  readonly driver = "llm" as const;
  constructor(private readonly cfg: OpenAiRealtimeConfig) {}

  async connect(opts: VoiceSessionOptions): Promise<VoiceSession> {
    const url = this.cfg.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.cfg.model)}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, maxPayload: MAX_FRAME_BYTES });
    const h = opts.handlers;
    let currentItemId: string | null = null;
    let audioMsSent = 0;
    let responseActive = false;

    const send = (event: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenAI Realtime connect timeout")), 10_000);
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
      type: "session.update",
      session: {
        type: "realtime",
        instructions: opts.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            noise_reduction: { type: "near_field" },
            transcription: { model: this.cfg.transcriptionModel },
            turn_detection: { type: "server_vad", threshold: 0.6, prefix_padding_ms: 300, silence_duration_ms: this.cfg.vadSilenceMs ?? 500, create_response: true, interrupt_response: true },
          },
          output: { format: { type: "audio/pcmu" }, voice: this.cfg.voice },
        },
        tools: opts.tools,
        tool_choice: "auto",
      },
    });
    send({ type: "response.create", response: { instructions: `Greet the caller with exactly: "${opts.greeting}" Then stop and listen.` } });

    ws.on("message", (raw) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (ev.type) {
        case "response.created":
          responseActive = true;
          break;
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (typeof ev.delta === "string") {
            if (typeof ev.item_id === "string" && ev.item_id !== currentItemId) {
              currentItemId = ev.item_id;
              audioMsSent = 0;
            }
            // mu-law 8 kHz: 8 bytes per ms.
            audioMsSent += Buffer.from(ev.delta, "base64").length / 8;
            h.onAudio(ev.delta);
          }
          break;
        case "input_audio_buffer.speech_started":
          h.onInterrupt();
          if (currentItemId) send({ type: "conversation.item.truncate", item_id: currentItemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioMsSent)) });
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (typeof ev.transcript === "string" && ev.transcript.trim()) h.onCallerTranscript(ev.transcript.trim());
          break;
        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done":
          if (typeof ev.transcript === "string" && ev.transcript.trim()) h.onAgentTranscript(ev.transcript.trim());
          break;
        case "response.function_call_arguments.done": {
          const callId = String(ev.call_id ?? "");
          const name = String(ev.name ?? "");
          let args: unknown = {};
          try {
            args = JSON.parse(String(ev.arguments ?? "{}"));
          } catch {
            args = {};
          }
          void h
            .onToolCall(name, args)
            .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
            .then((output) => {
              send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
              send({ type: "response.create" });
            });
          break;
        }
        case "response.done":
          responseActive = false;
          h.onResponseDone();
          break;
        case "error": {
          const err = ev.error as { message?: string; code?: string } | undefined;
          // Cancelling when nothing is active is harmless.
          if (err?.code !== "response_cancel_not_active") h.onError(new Error(`OpenAI Realtime: ${err?.message ?? "unknown error"}`));
          break;
        }
      }
    });
    ws.on("close", () => h.onClose());
    ws.on("error", (err) => h.onError(err));

    return {
      sendAudio(payload: string) {
        send({ type: "input_audio_buffer.append", audio: payload });
      },
      say(text: string, sayOpts?: { interrupt?: boolean }) {
        if (sayOpts?.interrupt !== false && responseActive) {
          send({ type: "response.cancel" });
          h.onInterrupt();
        }
        send({
          type: "response.create",
          response: { instructions: `Say exactly the following, word for word, calmly, and nothing else: "${text.replace(/"/g, "'")}"`, tool_choice: "none" },
        });
      },
      close() {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      },
    };
  }
}
