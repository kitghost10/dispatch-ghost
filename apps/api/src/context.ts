import type { FastifyBaseLogger } from "fastify";
import type { Geocoder } from "@sb/core";
import { createStore, type Store } from "@sb/db";
import {
  CensusGeocoder,
  GoogleCalendarProvider,
  HousecallProAdapter,
  JobberAdapter,
  MockCalendarProvider,
  MockTelephony,
  MockVoiceProvider,
  NoFsmAdapter,
  parseServiceAccount,
  ServiceTitanAdapter,
  StaticGeocoder,
  TwilioTelephony,
  type CalendarProvider,
  type FieldServiceAdapter,
  type Telephony,
  type VoiceProvider,
} from "@sb/providers";
import type { AppEnv } from "./config";
import { configuredVoice } from "./services/providers";
import { BullQueue, InlineQueue, type JobQueue, type Processor } from "./queue";

export interface AppContext {
  env: AppEnv;
  store: Store;
  telephony: Telephony;
  voice: VoiceProvider;
  calendar: CalendarProvider | null;
  fsm: Record<"servicetitan" | "housecallpro" | "jobber" | "none", FieldServiceAdapter>;
  geocoder?: Geocoder;
  queue: JobQueue;
  now: () => Date;
  log: Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;
  /** Set by jobs.ts once the context exists. */
  processor?: Processor;
}

export interface ContextOverrides {
  store?: Store;
  telephony?: Telephony;
  voice?: VoiceProvider;
  calendar?: CalendarProvider | null;
  now?: () => Date;
  geocoder?: Geocoder;
}

const consoleLog = {
  info: (...a: unknown[]) => console.info(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
  debug: () => undefined,
} as unknown as AppContext["log"];

export function createContext(env: AppEnv, overrides: ContextOverrides = {}): AppContext {
  const mock = env.APP_MODE === "mock";
  const store = overrides.store ?? createStore(env.DATABASE_URL);
  const telephony =
    overrides.telephony ??
    (!mock && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? new TwilioTelephony(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_MESSAGING_SERVICE_SID ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID } : {})
      : new MockTelephony());
  const voiceName =
    env.VOICE_PROVIDER ??
    (mock ? "mock" : env.ELEVENLABS_API_KEY ? "elevenlabs" : env.OPENAI_API_KEY ? "openai-realtime" : "mock");
  const voice = overrides.voice ?? (voiceName === "mock" ? new MockVoiceProvider() : configuredVoice(env, voiceName));
  const calendar =
    overrides.calendar !== undefined
      ? overrides.calendar
      : env.GOOGLE_SERVICE_ACCOUNT_JSON && !mock
        ? new GoogleCalendarProvider(parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON))
        : new MockCalendarProvider();
  const ctx: AppContext = {
    env,
    store,
    telephony,
    voice,
    calendar,
    fsm: {
      servicetitan: new ServiceTitanAdapter(
        {
          enabled: env.FSM_SERVICETITAN_ENABLED,
          live: env.FSM_SERVICETITAN_LIVE && !mock,
          ...(env.SERVICETITAN_CLIENT_ID ? { clientId: env.SERVICETITAN_CLIENT_ID } : {}),
          ...(env.SERVICETITAN_CLIENT_SECRET ? { clientSecret: env.SERVICETITAN_CLIENT_SECRET } : {}),
          ...(env.SERVICETITAN_APP_KEY ? { appKey: env.SERVICETITAN_APP_KEY } : {}),
        },
        fetch,
        (m, d) => consoleLog.info({ fsm: d }, m),
      ),
      housecallpro: new HousecallProAdapter({ enabled: env.FSM_HOUSECALLPRO_ENABLED, live: env.FSM_HOUSECALLPRO_LIVE && !mock, ...(env.HOUSECALLPRO_API_KEY ? { apiKey: env.HOUSECALLPRO_API_KEY } : {}) }),
      jobber: new JobberAdapter({ enabled: env.FSM_JOBBER_ENABLED }),
      none: new NoFsmAdapter(),
    },
    geocoder: overrides.geocoder ?? (mock ? new StaticGeocoder({ "Round Rock": { lat: 30.5083, lng: -97.6789, zip: "78664" } }) : new CensusGeocoder()),
    queue: undefined as unknown as JobQueue,
    now: overrides.now ?? (() => new Date()),
    log: consoleLog,
  };
  ctx.queue =
    env.REDIS_URL && !env.RUN_WORKER_INLINE
      ? new BullQueue(env.REDIS_URL)
      : new InlineQueue(
          () => {
            if (!ctx.processor) throw new Error("job processor not registered");
            return ctx.processor;
          },
          (err, name) => ctx.log.error({ err, job: name }, "inline job failed"),
        );
  return ctx;
}
