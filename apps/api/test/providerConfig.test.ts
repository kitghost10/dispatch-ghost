import { describe, expect, it } from "vitest";
import { demoTenantConfig, parseTenantConfig } from "@sb/core";
import { loadEnv } from "../src/config";
import { createContext } from "../src/context";
import { configuredVoice } from "../src/services/providers";

describe("provider configuration", () => {
  it("loads old saved clients with channel defaults", () => {
    const old = { ...demoTenantConfig() } as Record<string, unknown>;
    delete old.voice;
    expect(parseTenantConfig(old).voice).toEqual({ enabled: true, provider: "agency" });
  });
  it("rejects invalid timezones before they can break calls", () => {
    expect(() => parseTenantConfig({ ...demoTenantConfig(), timezone: "invalid-zone" })).toThrow();
  });
  it("requires both testing-stack keys and refuses mock voice in live mode", () => {
    const base = { APP_MODE: "live", PUBLIC_BASE_URL: "https://example.com", DATABASE_URL: "postgres://local", SESSION_SECRET: "strong-secret-for-test", TWILIO_ACCOUNT_SID: "sid", TWILIO_AUTH_TOKEN: "token" };
    expect(() => loadEnv({ ...base, VOICE_PROVIDER: "deepgram-openrouter" })).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => loadEnv({ ...base, VOICE_PROVIDER: "mock" })).toThrow();
    expect(loadEnv({ ...base, VOICE_PROVIDER: "deepgram-openrouter", DEEPGRAM_API_KEY: "dg", OPENROUTER_API_KEY: "or" }).VOICE_PROVIDER).toBe("deepgram-openrouter");
  });
  it("keeps ElevenLabs primary even when testing keys are present", () => {
    const env = loadEnv({ APP_MODE: "mock", ELEVENLABS_API_KEY: "el", ELEVENLABS_AGENT_ID: "primary", OPENROUTER_API_KEY: "or", DEEPGRAM_API_KEY: "dg" });
    const ctx = createContext({ ...env, APP_MODE: "live" });
    expect(ctx.voice.name).toBe("elevenlabs");
    expect(() => configuredVoice({ ...env, DEEPGRAM_API_KEY: undefined }, "deepgram-openrouter")).toThrow(/credentials/);
  });
});
