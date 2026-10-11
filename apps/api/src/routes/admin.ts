import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createTenantFromTemplate,
  agencySettingsSchema,
  applyAgencySettings,
  DEMO_ANSWERS,
  PLUMBING_SERVICES,
  PLUMBING_TEMPLATE_DEFAULTS,
  safeParseTenantConfig,
  ScriptedReceptionist,
  type OnboardingAnswers,
  type Priority,
  type SessionState,
} from "@sb/core";
import { verifyPassword } from "@sb/db";
import type { AppContext } from "../context";
import { authGuard, canAccessTenant, issueToken, type AuthedRequest } from "../auth";
import { newSession, textTurn } from "../services/conversations";
import { persistSession } from "../services/persist";
import { providerSetup } from "../services/providers";

type P = { id: string };

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "tenant";
}

export async function registerAdmin(app: FastifyInstance, ctx: AppContext) {
  const guard = authGuard(ctx.store, ctx.env.SESSION_SECRET);

  app.get("/health", async () => ({ ok: true, mode: ctx.env.APP_MODE, store: ctx.store.kind, voice: ctx.voice.name }));

  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const user = email ? await ctx.store.findUserByEmail(email.toLowerCase()) : null;
    if (!user || !password || !(await verifyPassword(password, user.passwordHash))) return reply.code(401).send({ error: "invalid_credentials" });
    return { token: issueToken(ctx.env.SESSION_SECRET, user.id), user: { id: user.id, email: user.email, isAgencyAdmin: user.isAgencyAdmin } };
  });

  // Everything below requires a bearer token.
  app.register(async (api) => {
    api.addHook("preHandler", guard);

    const tenantOr404 = async (req: AuthedRequest, reply: FastifyReply) => {
      const id = (req.params as P).id;
      if (!req.user || !(await canAccessTenant(ctx.store, req.user, id))) {
        reply.code(404).send({ error: "not_found" });
        return null;
      }
      const tenant = await ctx.store.getTenant(id);
      if (!tenant) {
        reply.code(404).send({ error: "not_found" });
        return null;
      }
      return tenant;
    };

    api.get("/api/me", async (req: AuthedRequest) => {
      const u = req.user!;
      return { id: u.id, email: u.email, isAgencyAdmin: u.isAgencyAdmin };
    });

    api.get("/api/setup", async () => providerSetup(ctx));

    api.get("/api/agency/settings", async (req: AuthedRequest, reply) => {
      if (!req.user?.isAgencyAdmin) return reply.code(403).send({ error: "agency_admin_only" });
      const settings = await ctx.store.getAgencySettings();
      const accounts = await ctx.store.listTenants();
      const config = applyAgencySettings(createTenantFromTemplate({ ...DEMO_ANSWERS, voice: { enabled: true, provider: "elevenlabs" } }), settings);
      return { settings, config, accounts: accounts.map(({ id, name, status }) => ({ id, name, status })) };
    });

    api.put("/api/agency/settings", async (req: AuthedRequest, reply) => {
      if (!req.user?.isAgencyAdmin) return reply.code(403).send({ error: "agency_admin_only" });
      const parsed = agencySettingsSchema.safeParse((req.body as { settings?: unknown } | undefined)?.settings);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_settings", issues: parsed.error.issues });
      if (!Object.keys(parsed.data).length) return reply.code(400).send({ error: "select_settings" });
      return ctx.store.applyAgencySettings(parsed.data);
    });

    let modelCache: { expires: number; models: Array<{ id: string; name: string }> } | null = null;
    api.get("/api/models/openrouter", async (_req, reply) => {
      if (modelCache && modelCache.expires > Date.now()) return modelCache.models;
      try {
        const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error("Model catalog unavailable");
        const body = await res.json() as { data: Array<{ id: string; name: string; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } }> };
        const models = body.data.filter((m) => m.supported_parameters?.includes("tools") && m.architecture?.output_modalities?.includes("text")).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        modelCache = { expires: Date.now() + 3600_000, models };
        return models;
      } catch { return reply.code(503).send({ error: "model_catalog_unavailable" }); }
    });

    api.get("/api/tenants", async (req: AuthedRequest) => {
      const u = req.user!;
      const all = await ctx.store.listTenants();
      const memberOf = new Set((await ctx.store.listMemberships(u.id)).map((m) => m.tenantId));
      const allowed = u.isAgencyAdmin ? all : all.filter((t) => memberOf.has(t.id));
      return Promise.all(
        allowed.map(async (t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status, channels: { voice: t.config.voice.enabled, sms: t.config.sms.enabled }, agentName: t.config.brand.agentName, numbers: await ctx.store.listPhoneNumbers(t.id), stats: await ctx.store.stats(t.id, ctx.now()) })),
      );
    });

    api.get("/api/onboarding/template", async () => ({ services: PLUMBING_SERVICES, defaults: PLUMBING_TEMPLATE_DEFAULTS, example: DEMO_ANSWERS }));

    api.post("/api/tenants", async (req: AuthedRequest, reply) => {
      if (!req.user?.isAgencyAdmin) return reply.code(403).send({ error: "agency_admin_only" });
      const body = (req.body ?? {}) as { slug?: string; answers?: OnboardingAnswers; phoneNumbers?: string[] };
      if (!body.answers) return reply.code(400).send({ error: "answers_required" });
      let config;
      try {
        config = createTenantFromTemplate(body.answers);
      } catch (err) {
        return reply.code(400).send({ error: "invalid_config", issues: (err as { issues?: unknown }).issues ?? String(err) });
      }
      const slug = slugify(body.slug ?? config.brand.companyName);
      if ((await ctx.store.listTenants()).some((t) => t.slug === slug)) return reply.code(409).send({ error: "slug_taken" });
      for (const n of body.phoneNumbers ?? []) {
        if (!/^\+1\d{10}$/.test(n)) return reply.code(400).send({ error: "invalid_phone_number", number: n });
        if (await ctx.store.resolveTenantByNumber(n)) return reply.code(409).send({ error: "number_in_use", number: n });
      }
      const tenant = await ctx.store.createTenant({ slug, name: config.brand.companyName, config, status: "onboarding" });
      for (const n of body.phoneNumbers ?? []) await ctx.store.addPhoneNumber(tenant.id, n);
      return reply.code(201).send(tenant);
    });

    api.get("/api/tenants/:id", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return { ...t, numbers: await ctx.store.listPhoneNumbers(t.id) };
    });

    api.post("/api/tenants/:id/numbers", async (req: AuthedRequest, reply) => {
      if (!req.user?.isAgencyAdmin) return reply.code(403).send({ error: "agency_admin_only" });
      const tenant = await tenantOr404(req, reply);
      if (!tenant) return;
      const number = (req.body as { number?: string } | undefined)?.number;
      if (typeof number !== "string" || !/^\+1\d{10}$/.test(number)) return reply.code(400).send({ error: "invalid_phone_number" });
      const owner = await ctx.store.resolveTenantByNumber(number);
      if (owner && owner !== tenant.id) return reply.code(409).send({ error: "number_in_use" });
      if (!owner) await ctx.store.addPhoneNumber(tenant.id, number);
      return { numbers: await ctx.store.listPhoneNumbers(tenant.id) };
    });

    api.put("/api/tenants/:id/config", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const body = (req.body ?? {}) as { config?: unknown; name?: string };
      const parsed = safeParseTenantConfig(body.config);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_config", issues: parsed.error.issues });
      return ctx.store.updateTenantConfig(t.id, parsed.data, body.name ?? parsed.data.brand.companyName);
    });

    api.put("/api/tenants/:id/status", async (req: AuthedRequest, reply) => {
      if (!req.user?.isAgencyAdmin) return reply.code(403).send({ error: "agency_admin_only" });
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const status = (req.body as { status?: string } | undefined)?.status;
      if (status !== "onboarding" && status !== "active" && status !== "paused") return reply.code(400).send({ error: "invalid_status" });
      return ctx.store.setTenantStatus(t.id, status);
    });

    api.get("/api/tenants/:id/stats", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return ctx.store.stats(t.id, ctx.now());
    });

    api.get("/api/tenants/:id/calls", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const q = req.query as { priority?: Priority; limit?: string };
      const calls = await ctx.store.listCalls(t.id, { limit: Math.min(Number(q.limit ?? 100), 500), ...(q.priority ? { priority: q.priority } : {}) });
      return calls.map(({ state: _state, ...c }) => c);
    });

    api.get("/api/tenants/:id/calls/:callId", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const callId = (req.params as { callId: string }).callId;
      const call = await ctx.store.getCall(t.id, callId);
      if (!call) return reply.code(404).send({ error: "not_found" });
      const state = call.state as SessionState | null;
      const [transcript, events, bookings] = await Promise.all([ctx.store.listTranscript(t.id, callId), ctx.store.listEvents(t.id, callId), ctx.store.listBookings(t.id, { limit: 1000 })]);
      return {
        call: { ...call, state: undefined },
        facts: state?.facts ?? null,
        triage: state?.triage ?? null,
        customer: state?.customer ?? null,
        transcript,
        events,
        bookings: bookings.filter((b) => b.callId === callId),
      };
    });

    api.get("/api/tenants/:id/bookings", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return ctx.store.listBookings(t.id, { limit: 200 });
    });

    api.get("/api/tenants/:id/sms", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return ctx.store.listSms(t.id, { limit: 300 });
    });

    api.get("/api/tenants/:id/missed-calls", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return ctx.store.listMissedCallTexts(t.id, 200);
    });

    api.get("/api/tenants/:id/callbacks", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const q = req.query as { status?: "open" | "done" };
      return ctx.store.listCallbacks(t.id, { limit: 200, ...(q.status ? { status: q.status } : {}) });
    });

    api.post("/api/tenants/:id/callbacks/:cbId/complete", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      await ctx.store.completeCallback(t.id, (req.params as { cbId: string }).cbId);
      return { ok: true };
    });

    api.get("/api/tenants/:id/alerts", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      return ctx.store.listAlerts(t.id, 200);
    });

    /**
     * Dashboard simulator: talk to the tenant's receptionist by text using the
     * same engine as the phone line. Side effects are recorded, never sent.
     */
    api.post("/api/tenants/:id/simulate", async (req: AuthedRequest, reply) => {
      const t = await tenantOr404(req, reply);
      if (!t) return;
      const body = (req.body ?? {}) as { callId?: string; text?: string; from?: string; afterHours?: boolean; transferResult?: "connected" | "failed" };
      let callId = body.callId;
      let state: SessionState | null = null;
      if (callId) {
        const existing = await ctx.store.getCall(t.id, callId);
        if (!existing || existing.channel !== "simulator") return reply.code(404).send({ error: "not_found" });
        state = existing.state as SessionState | null;
      }
      const from = body.from ?? "+15125550142";
      if (!callId || !state) {
        const call = await ctx.store.createCall(t.id, { fromE164: from, toE164: "simulator", channel: "simulator", afterHours: false, providerCallSid: null });
        callId = call.id;
      }
      const { session, effects } = state
        ? newSession(ctx, t, callId, { state }, { simulated: true })
        : newSession(ctx, t, callId, { channel: "voice", callerPhone: from }, { simulated: true });
      if (!state && typeof body.afterHours === "boolean") session.state.afterHours = body.afterHours;
      let say: string;
      let actions: unknown[] = [];
      if (body.transferResult) {
        const turn = await session.transferResult(body.transferResult);
        say = turn.say;
        actions = turn.actions;
      } else if (!body.text) {
        say = new ScriptedReceptionist(session).greeting();
      } else {
        await ctx.store.appendTranscript(t.id, callId, "caller", body.text);
        const history = await ctx.store.listTranscript(t.id, callId);
        const turn = await textTurn(ctx, session, body.text, history.slice(0, -1), { allowLlm: false });
        say = turn.say;
        actions = turn.actions;
      }
      if (say) await ctx.store.appendTranscript(t.id, callId, "agent", say);
      await ctx.store.updateCall(t.id, callId, { afterHours: session.state.afterHours });
      await persistSession(ctx, t.id, callId, session, session.state.ended ? { endedAt: ctx.now().toISOString(), status: "completed" } : {});
      await effects.flush();
      return {
        callId,
        say,
        actions,
        priority: session.state.peakPriority,
        issue: session.state.facts.issue,
        safetyFlags: session.state.facts.safetyFlags,
        reasonCodes: session.state.triage.reasonCodes,
        outcome: session.state.outcome,
        ended: session.state.ended,
        afterHours: session.state.afterHours,
      };
    });
  });
}
