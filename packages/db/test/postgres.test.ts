/**
 * Runs against a real Postgres when TEST_MIGRATION_DATABASE_URL (owner) and
 * TEST_DATABASE_URL (sb_app) are set; skipped otherwise.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoTenantConfig } from "@sb/core";
import { migrate, PgStore } from "../src";
import { storeContract } from "./store.contract";

const OWNER = process.env.TEST_MIGRATION_DATABASE_URL;
const APP = process.env.TEST_DATABASE_URL;
const enabled = Boolean(OWNER && APP);

describe.skipIf(!enabled)("postgres", () => {
  let store: PgStore;
  beforeAll(async () => {
    const c = new pg.Client({ connectionString: OWNER });
    await c.connect();
    await c.query("DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await c.end();
    await migrate(OWNER!, { appRolePassword: new URL(APP!).password || "sb_app_dev" });
    store = new PgStore(APP!, 4);
  });
  afterAll(async () => {
    await store?.close();
  });

  storeContract("postgres", async () => store);

  it("persists global defaults, applies them atomically, and initializes new accounts", async () => {
    const config = demoTenantConfig();
    const applied = await store.applyAgencySettings({ voice: { enabled: true, provider: "elevenlabs", model: "shared-model" } });
    expect(applied.updatedAccounts).toBe((await store.listTenants()).length);
    expect((await store.getAgencySettings()).voice?.model).toBe("shared-model");
    const tenant = await store.createTenant({ slug: "agency-new-client", name: "New agency client", config });
    expect(tenant.config.voice.model).toBe("shared-model");
    expect(tenant.config.brand).toEqual(config.brand);
    expect((await store.with({ tenantId: tenant.id, actor: "tenant" }, (q) => q("SELECT * FROM agency_settings"))).rows).toHaveLength(0);
    const prior = await store.getAgencySettings();
    await expect(store.applyAgencySettings({ booking: { ...config.booking, capacity: 0 } })).rejects.toThrow();
    expect(await store.getAgencySettings()).toEqual(prior);
    expect((await store.getTenant(tenant.id))?.config.booking.capacity).toBe(config.booking.capacity);
  });

  it("RLS: a tenant context cannot read another tenant's rows, even without WHERE", async () => {
    const a = await store.createTenant({ slug: "rls-a", name: "A", config: demoTenantConfig() });
    const b = await store.createTenant({ slug: "rls-b", name: "B", config: demoTenantConfig() });
    await store.createCall(a.id, { fromE164: "+15125550001", toE164: "+15125550199", channel: "voice", afterHours: false });
    await store.createCall(b.id, { fromE164: "+15125550002", toE164: "+15125550198", channel: "voice", afterHours: false });
    const seen = await store.with({ tenantId: a.id, actor: "tenant" }, async (q) => (await q("SELECT tenant_id FROM calls")).rows.map((r) => String(r.tenant_id)));
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([a.id]));
    const tenants = await store.with({ tenantId: a.id, actor: "tenant" }, async (q) => (await q("SELECT id FROM tenants")).rows.map((r) => String(r.id)));
    expect(tenants).toEqual([a.id]);
  });

  it("RLS: inserting a row for another tenant is rejected", async () => {
    const a = (await store.listTenants()).find((t) => t.slug === "rls-a")!;
    const b = (await store.listTenants()).find((t) => t.slug === "rls-b")!;
    await expect(
      store.with({ tenantId: a.id, actor: "tenant" }, (q) => q("INSERT INTO callback_tasks (tenant_id, priority, reason, caller_phone, due_at) VALUES ($1, 'P3', 'x', '+1', now())", [b.id])),
    ).rejects.toThrow(/row-level security/);
  });

  it("RLS: no context sees nothing", async () => {
    const rows = await store.with({ actor: "none" }, async (q) => (await q("SELECT count(*)::int AS n FROM calls")).rows[0]?.n);
    expect(rows).toBe(0);
    const users = await store.with({ actor: "none" }, async (q) => (await q("SELECT count(*)::int AS n FROM users")).rows[0]?.n);
    expect(users).toBe(0);
  });

  it("the runtime role cannot bypass RLS", async () => {
    const r = await store.with({ actor: "none" }, async (q) => (await q("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0]?.rolbypassrls);
    expect(r).toBe(false);
  });
});
