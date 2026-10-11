/**
 * Swappable voice provider boundary.
 *
 * The gateway owns the Twilio Media Stream (mu-law 8 kHz, base64 frames) and
 * hands audio to a VoiceSession. Two driving modes:
 *  - "llm": the provider converses and calls tools (ElevenLabs Agents by
 *    default; OpenAI Realtime remains an optional fallback).
 *  - "scripted": the gateway's ScriptedReceptionist decides what to say and
 *    the provider only transcribes/speaks (mock provider in dev/tests).
 *
 * Adding a provider means implementing VoiceProvider; nothing in the
 * plumbing domain changes.
 */
import type { ToolDefinition } from "@sb/core";

export interface VoiceSessionHandlers {
  /** Base64 mu-law audio to play to the caller. */
  onAudio(payload: string): void;
  /** Caller barged in: flush queued playback. */
  onInterrupt(): void;
  onCallerTranscript(text: string): unknown;
  onAgentTranscript(text: string): unknown;
  /** Model tool call. Return the JSON output. */
  onToolCall(name: string, args: unknown): Promise<Record<string, unknown>>;
  /** Model finished speaking a response (safe point to run pending actions). */
  onResponseDone(): void;
  onError(error: Error): void;
  onClose(): void;
}

export interface VoiceSessionOptions {
  instructions: string;
  tools: ToolDefinition[];
  greeting: string;
  /** Sanitize a generated reply before speech synthesis. */
  filterReply?: (text: string) => string;
  handlers: VoiceSessionHandlers;
}

export interface VoiceSession {
  sendAudio(payload: string): void;
  /**
   * Speak text verbatim, interrupting whatever the model is saying. Used for
   * deterministic safety scripts and in scripted mode.
   */
  say(text: string, opts?: { interrupt?: boolean }): void;
  close(): void;
}

export interface VoiceProvider {
  readonly name: string;
  readonly driver: "llm" | "scripted";
  connect(opts: VoiceSessionOptions): Promise<VoiceSession>;
}
