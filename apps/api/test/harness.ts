import pg from "pg";
import { DEMO_BUSINESS_NUMBER, MemoryStore, migrate, PgStore, seedDemo, type Store, type Tenant } from "@sb/db";
import { MockTelephony, MockVoiceProvider } from "@sb/providers";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../src/config";
import { createContext, type AppContext } from "../src/context";
import { buildServer } from "../src/server";
import { CallDriver, parseDial } from "../src/dev/callDriver";


/** Tuesday 10:00 AM Central (office open). */
export const TUE_10AM = new Date("2026-09-29T15:00:00Z");
/** Tuesday 11:30 PM Central (after hours). */
export const TUE_1130PM = new Date("2026-09-30T04:30:00Z");

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  telephony: MockTelephony;
  store: Store;
  tenant: Tenant;
  base: string;
  clock: { now: Date };
  call(from?: string): CallDriver;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export async function startTestApp(at: Date, opts: { configure?: (t: Tenant) => Tenant["config"] } = {}): Promise<TestApp> {
  const clock = { now: at };
  const telephony = new MockTelephony();
  const store = await makeStore();
  const env = loadEnv({ APP_MODE: "mock", LOG_LEVEL: "silent", SESSION_SECRET: "test-secret-test-secret" } as NodeJS.ProcessEnv);
  const ctx = createContext(env, { store, telephony, voice: new MockVoiceProvider(), now: () => clock.now });
  let { tenant } = await seedDemo(store, { adminPassword: "pw-admin", ownerPassword: "pw-owner" });
  if (opts.configure) tenant = await store.updateTenantConfig(tenant.id, opts.configure(tenant));
  const app = await buildServer(ctx, { logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  ctx.env.PUBLIC_BASE_URL = base;
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 60));
    await ctx.queue.drain();
  };
  return {
    app,
    ctx,
    telephony,
    store,
    tenant,
    base,
    clock,
    call: (from = "+15125559876") => new CallDriver({ baseUrl: base, from, to: DEMO_BUSINESS_NUMBER, quietMs: 60 }),
    settle,
    close: async () => {
      await settle();
      await app.close();
      await store.close();
    },
  };
}

/**
 * In-memory by default. With SCENARIO_PG=1 plus TEST_MIGRATION_DATABASE_URL /
 * TEST_DATABASE_URL, the same scenarios run against Postgres under RLS as the
 * sb_app role (tables are truncated before each test).
 */
let migrated = false;
async function makeStore(): Promise<Store> {
  const owner = process.env.TEST_MIGRATION_DATABASE_URL;
  const app = process.env.TEST_DATABASE_URL;
  if (process.env.SCENARIO_PG !== "1" || !owner || !app) return new MemoryStore();
  if (!migrated) {
    await migrate(owner, { appRolePassword: new URL(app).password });
    migrated = true;
  }
  const c = new pg.Client({ connectionString: owner });
  await c.connect();
  const { rows } = await c.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  if (rows.length) await c.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
  await c.end();
  const store = new PgStore(app, 5);
  openStores.push(store);
  return store;
}
const openStores: PgStore[] = [];

/** The TwiML the gateway pushed onto the live call (transfer or hangup). */
export function liveUpdate(t: TestApp, callSid: string): { twiml: string; dial: ReturnType<typeof parseDial>; hangup: boolean } | null {
  const u = t.telephony.liveCallUpdates.filter((x) => x.callSid === callSid).at(-1);
  if (!u) return null;
  return { twiml: u.twiml, dial: parseDial(u.twiml), hangup: u.twiml.includes("<Hangup/>") };
}

export async function callRecord(t: TestApp, callId: string) {
  const c = await t.store.getCall(t.tenant.id, callId);
  if (!c) throw new Error("call not found");
  return c;
}

export function smsTo(t: TestApp, phone: string) {
  return t.telephony.sms.filter((m) => m.to === phone);
}
