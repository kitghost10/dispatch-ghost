import type { TenantConfig } from "@sb/core";
import { DeepgramOpenRouterProvider, ElevenLabsConversationalProvider, OpenAiRealtimeProvider, type VoiceProvider } from "@sb/providers";
import type { AppContext } from "../context";
import type { AppEnv } from "../config";

export function configuredVoice(env: AppEnv, provider: string, config?: TenantConfig["voice"]): VoiceProvider {
  if (provider === "deepgram-openrouter" && env.DEEPGRAM_API_KEY && env.OPENROUTER_API_KEY) return new DeepgramOpenRouterProvider({
    deepgramApiKey: env.DEEPGRAM_API_KEY, openRouterApiKey: env.OPENROUTER_API_KEY,
    model: config?.model ?? env.OPENROUTER_MODEL,
    transcriptionModel: config?.transcriptionModel ?? env.DEEPGRAM_TRANSCRIPTION_MODEL,
    speechModel: config?.speechModel ?? env.DEEPGRAM_SPEECH_MODEL,
  });
  if (provider === "elevenlabs" && env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID) return new ElevenLabsConversationalProvider({ apiKey: env.ELEVENLABS_API_KEY, agentId: env.ELEVENLABS_AGENT_ID, voiceId: env.ELEVENLABS_VOICE_ID, ttsModel: env.ELEVENLABS_TTS_MODEL });
  if (provider === "openai-realtime" && env.OPENAI_API_KEY) return new OpenAiRealtimeProvider({ apiKey: env.OPENAI_API_KEY, model: config?.model ?? env.OPENAI_REALTIME_MODEL, voice: env.OPENAI_REALTIME_VOICE, transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL });
  throw new Error(`Missing credentials for ${provider}`);
}

export function tenantVoice(ctx: AppContext, config: TenantConfig): VoiceProvider {
  if (ctx.env.APP_MODE === "mock") return ctx.voice;
  const provider = config.voice.provider === "agency" ? ctx.voice.name : config.voice.provider;
  if (config.voice.provider === "agency" && !config.voice.model && !config.voice.transcriptionModel && !config.voice.speechModel) return ctx.voice;
  return configuredVoice(ctx.env, provider, config.voice);
}

/** Readiness checks only presence of configuration; never claims live connectivity. */
export function providerSetup(ctx: AppContext) {
  const env = ctx.env;
  return {
    mode: env.APP_MODE,
    baseUrl: env.PUBLIC_BASE_URL,
    defaultVoice: ctx.voice.name,
    defaultSms: env.OPENAI_API_KEY ? "openai" : "openrouter",
    connections: {
      twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      elevenlabs: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID),
      openai: Boolean(env.OPENAI_API_KEY),
      openrouter: Boolean(env.OPENROUTER_API_KEY),
      deepgram: Boolean(env.DEEPGRAM_API_KEY),
      google: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
    },
    defaults: { openrouterModel: env.OPENROUTER_MODEL, openaiModel: env.OPENAI_REALTIME_MODEL, smsModel: env.OPENAI_SMS_MODEL, transcriptionModel: env.DEEPGRAM_TRANSCRIPTION_MODEL, speechModel: env.DEEPGRAM_SPEECH_MODEL },
  };
}
