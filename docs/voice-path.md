# Voice path: what LobbyStack does today and what we chose

## Verified upstream history (LobbyStack, pinned at `c6d0a66`)

| Commit | Date | Change |
| --- | --- | --- |
| `e88a20c0fd6a9045f73472df2d08d38a75a61178` | 2026-09 | Last commit that has `apps/voice-gateway`: a Fastify service that bridges **Twilio Media Streams ↔ OpenAI Realtime** over WebSocket (default model `gpt-realtime-2.1`, voice `marin`, transcription `gpt-4o-mini-transcribe`, audio `audio/pcmu`, server VAD, barge-in via `clear`). |
| `5e86167` (#193) | 2026-09-26 | Adds **GPT-Live** (`gpt-live-1`) over **Twilio Elastic SIP trunking → OpenAI SIP** plus a WebRTC browser path. Gated by `LIVE_PROTOTYPE_ENABLED` (see LobbyStack ADR 0008 "gpt-live-voice"). |
| `d8c31ec` (#201) | 2026-09-26 | **Removes** the Fastify voice gateway (Media Streams + Realtime). |
| `c6d0a6644f00a628ceb1339de518405d4967a46b` (#225) | 2026-09-27 | HEAD at the time we pinned it ("Start browser calls sooner and compact product_events"). |

So the hypothesis we were given was right. LobbyStack's current phone path runs on a model that is two days old, sits behind a prototype flag, and depends on Twilio SIP.

## Decision

We keep **Twilio Media Streams** so every caller transcript still hits `ReceptionistSession.observeCaller()` for P0 interrupts, transfers stay on `<Dial action=…>`, and numbers stay ordinary Twilio DIDs.

Live voice is **ElevenLabs Agents** (`packages/providers/src/voice/elevenlabsConversational.ts`): mu-law 8 kHz in both directions (`ulaw_8000`), client tools mapped to `RECEPTIONIST_TOOLS`, and verbatim safety lines via the ElevenLabs TTS API so the voice stays consistent when we interrupt the model.

OpenAI Realtime remains an optional `VOICE_PROVIDER=openai-realtime` fallback. The mock provider still drives tests.

## Swappable provider

`packages/providers/src/voice/types.ts` defines `VoiceProvider` / `VoiceSession`:

- `driver: "llm"`: the provider's model converses and calls our tools (`RECEPTIONIST_TOOLS`). The gateway still enforces P0 and the price guard.
- `driver: "scripted"`: the gateway's `ScriptedReceptionist` decides each reply and the provider only transcribes and speaks. The mock provider uses this, so the whole phone path runs in tests without keys.

Implementations today: `elevenlabs` (default in live mode), `openai-realtime`, and `mock`.

Fallback: if the provider fails to connect, the gateway transfers the caller to a human (office number during hours, on-call rota after hours) instead of dropping the call.
