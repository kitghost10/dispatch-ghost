import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const envSchema = z.object({
  /** mock: no real Twilio/ElevenLabs; live: real providers (keys required). */
  APP_MODE: z.enum(["mock", "live"]).default("mock"),
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  /** Public https URL Twilio reaches (used for webhooks, stream URL and signature validation). */
  PUBLIC_BASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  RUN_WORKER_INLINE: bool,

  SESSION_SECRET: z.string().min(16).default("dev-only-session-secret-change-me"),
  DASHBOARD_ORIGIN: z.string().default("http://localhost:3000"),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  /** When Twilio Advanced Opt-Out handles STOP/HELP replies, don't send our own. */
  TWILIO_ADVANCED_OPT_OUT: bool,
  TWILIO_VALIDATE_SIGNATURES: z.string().optional().transform((v) => v !== "false"),

  VOICE_PROVIDER: z.enum(["elevenlabs", "openai-realtime", "deepgram-openrouter", "mock"]).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_TTS_MODEL: z.string().default("eleven_flash_v2_5"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4.1-mini"),
  OPENROUTER_SMS_MODEL: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_TRANSCRIPTION_MODEL: z.string().default("nova-3"),
  DEEPGRAM_SPEECH_MODEL: z.string().default("aura-2-thalia-en"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  OPENAI_SMS_MODEL: z.string().default("gpt-4.1-mini"),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  FSM_SERVICETITAN_ENABLED: bool,
  FSM_SERVICETITAN_LIVE: bool,
  SERVICETITAN_CLIENT_ID: z.string().optional(),
  SERVICETITAN_CLIENT_SECRET: z.string().optional(),
  SERVICETITAN_APP_KEY: z.string().optional(),
  FSM_HOUSECALLPRO_ENABLED: bool,
  FSM_HOUSECALLPRO_LIVE: bool,
  HOUSECALLPRO_API_KEY: z.string().optional(),
  FSM_JOBBER_ENABLED: bool,

  /** Mock mode: seed the demo tenant and sample calls on startup. */
  SEED_DEMO: z.string().optional().transform((v) => v !== "false"),
  SEED_ADMIN_PASSWORD: z.string().default("sonicbold-demo"),
});

export type AppEnv = Omit<z.infer<typeof envSchema>, "PUBLIC_BASE_URL"> & { PUBLIC_BASE_URL: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(source);
  const env: AppEnv = { ...parsed, PUBLIC_BASE_URL: (parsed.PUBLIC_BASE_URL ?? `http://localhost:${parsed.PORT}`).replace(/\/$/, "") };
  if (env.APP_MODE === "live") {
    const missing = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "DATABASE_URL"].filter((k) => !env[k as keyof AppEnv]);
    if (env.SESSION_SECRET.startsWith("dev-only")) missing.push("SESSION_SECRET (non-default)");
    const voice = env.VOICE_PROVIDER ?? (env.ELEVENLABS_API_KEY ? "elevenlabs" : env.OPENAI_API_KEY ? "openai-realtime" : "");
    if (voice === "elevenlabs") {
      if (!env.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
      if (!env.ELEVENLABS_AGENT_ID) missing.push("ELEVENLABS_AGENT_ID");
    } else if (voice === "deepgram-openrouter") {
      if (!env.DEEPGRAM_API_KEY) missing.push("DEEPGRAM_API_KEY");
      if (!env.OPENROUTER_API_KEY) missing.push("OPENROUTER_API_KEY");
    } else if (voice === "openai-realtime") {
      if (!env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
    } else {
      missing.push("a live voice provider: ElevenLabs, OpenAI Realtime, or Deepgram + OpenRouter (mock is not allowed)");
    }
    if (missing.length) throw new Error(`APP_MODE=live requires: ${missing.join(", ")}`);
    if (!env.PUBLIC_BASE_URL.startsWith("https://")) throw new Error("APP_MODE=live requires an https PUBLIC_BASE_URL");
  }
  return env;
}
