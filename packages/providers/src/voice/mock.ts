/**
 * Mock voice provider for dev and tests: "audio" frames carry base64 UTF-8
 * text instead of mu-law. Caller frames become transcripts; `say` produces
 * frames back. Lets the full Twilio Media Stream path run without OpenAI.
 */
import type { VoiceProvider, VoiceSession, VoiceSessionOptions } from "./types";

export const MOCK_AUDIO_PREFIX = "mocktext:";

export function encodeMockAudio(text: string): string {
  return Buffer.from(`${MOCK_AUDIO_PREFIX}${text}`, "utf8").toString("base64");
}

export function decodeMockAudio(payload: string): string | null {
  const s = Buffer.from(payload, "base64").toString("utf8");
  return s.startsWith(MOCK_AUDIO_PREFIX) ? s.slice(MOCK_AUDIO_PREFIX.length) : null;
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock";
  readonly driver = "scripted" as const;

  async connect(opts: VoiceSessionOptions): Promise<VoiceSession> {
    const h = opts.handlers;
    let closed = false;
    const speak = (text: string) => {
      if (closed || !text) return;
      h.onAgentTranscript(text);
      h.onAudio(encodeMockAudio(text));
      h.onResponseDone();
    };
    queueMicrotask(() => speak(opts.greeting));
    return {
      sendAudio(payload: string) {
        const text = decodeMockAudio(payload);
        // Real mu-law silence/noise is ignored in mock mode.
        if (text && !closed) h.onCallerTranscript(text);
      },
      say(text: string, sayOpts?: { interrupt?: boolean }) {
        if (sayOpts?.interrupt) h.onInterrupt();
        speak(text);
      },
      close() {
        if (!closed) {
          closed = true;
          h.onClose();
        }
      },
    };
  }
}
