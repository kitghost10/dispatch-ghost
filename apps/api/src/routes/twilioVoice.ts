import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isOpen, type SessionState } from "@sb/core";
import { connectStreamTwiml, emptyTwiml, say, sayHangupTwiml, twiml } from "@sb/providers";
import type { AppContext } from "../context";
import { sign, verifySig } from "../auth";
import { newSession } from "../services/conversations";
import { persistSession } from "../services/persist";
import { transferDialTwiml } from "../services/transfer";

type Form = Record<string, string>;

export function twilioGuard(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.env.TWILIO_VALIDATE_SIGNATURES) return;
    const url = `${ctx.env.PUBLIC_BASE_URL}${req.url}`;
    const params = (req.body ?? {}) as Form;
    const ok = ctx.telephony.validateSignature({ url, params, signature: req.headers["x-twilio-signature"] as string | undefined });
    if (!ok) {
      ctx.log.warn({ url }, "rejected request with invalid Twilio signature");
      return reply.code(403).send("invalid signature");
    }
  };
}

function xml(reply: FastifyReply, body: string) {
  return reply.header("Content-Type", "text/xml").send(body);
}

function checkSignedQuery(ctx: AppContext, q: Record<string, string | undefined>): { tenantId: string; callId: string } | null {
  if (!q.tenantId || !q.callId || !verifySig(ctx.env.SESSION_SECRET, `${q.tenantId}:${q.callId}`, q.sig)) return null;
  return { tenantId: q.tenantId, callId: q.callId };
}

export function streamUrl(ctx: AppContext): string {
  const u = new URL("/twilio/media-stream", ctx.env.PUBLIC_BASE_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export async function registerTwilioVoice(app: FastifyInstance, ctx: AppContext) {
  const guard = twilioGuard(ctx);

  app.post("/twilio/voice/incoming", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    const tenantId = await ctx.store.resolveTenantByNumber(f.To ?? "");
    const tenant = tenantId ? await ctx.store.getTenant(tenantId) : null;
    if (!tenant) return xml(reply, sayHangupTwiml("Sorry, this number is not in service."));
    const existing = f.CallSid ? await ctx.store.getCallBySid(tenant.id, f.CallSid) : null;
    const call =
      existing ??
      (await ctx.store.createCall(tenant.id, { providerCallSid: f.CallSid ?? null, fromE164: f.From ?? "unknown", toE164: f.To ?? "", channel: "voice", afterHours: !isOpen(tenant.config, ctx.now()) }));
    if (tenant.status === "paused" || !tenant.config.voice.enabled) {
      const office = tenant.config.transfer.officeNumber;
      return xml(reply, office ? twiml(`<Dial>${office}</Dial>`) : sayHangupTwiml("Sorry, we can't take your call right now. Please try again later."));
    }
    const token = sign(ctx.env.SESSION_SECRET, `${tenant.id}:${call.id}`);
    return xml(
      reply,
      connectStreamTwiml({
        ...(tenant.config.recording.enabled ? { preamble: tenant.config.recording.preamble } : {}),
        streamUrl: streamUrl(ctx),
        parameters: { tenantId: tenant.id, callId: call.id, token },
      }),
    );
  });

  // Call status callback (configure on the number): completed / busy / no-answer / failed / canceled.
  app.post("/twilio/voice/status", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(f.CallStatus ?? "")) return reply.code(204).send();
    const tenantId = await ctx.store.resolveTenantByNumber(f.To ?? "");
    if (!tenantId || !f.CallSid) return reply.code(204).send();
    let call = await ctx.store.getCallBySid(tenantId, f.CallSid);
    if (!call) {
      call = await ctx.store.createCall(tenantId, { providerCallSid: f.CallSid, fromE164: f.From ?? "unknown", toE164: f.To ?? "", channel: "voice", afterHours: false });
    }
    const status = f.CallStatus ?? "completed";
    const transcript = await ctx.store.listTranscript(tenantId, call.id);
    const callerSpoke = transcript.some((t) => t.role === "caller");
    const state = call.state as SessionState | null;
    const abandoned = callerSpoke && (!call.outcome || call.outcome === "in_progress" || call.outcome === "abandoned") && call.priority !== "P0";
    const missed = status !== "completed" || !callerSpoke;
    await ctx.store.updateCall(tenantId, call.id, {
      status,
      endedAt: ctx.now().toISOString(),
      durationSec: f.CallDuration ? Number(f.CallDuration) : null,
      missed,
      ...(abandoned && state ? { outcome: "abandoned" } : !callerSpoke ? { outcome: "abandoned" } : {}),
    });
    if (missed || abandoned) {
      await ctx.queue.enqueue(
        "missed-call.textback",
        { tenantId, callId: call.id, phone: call.fromE164 },
        // One text per caller per 12h window even if they call repeatedly (BullMQ dedupes by jobId;
        // missedCallTextBack also checks recent sends).
        { delayMs: ctx.env.APP_MODE === "mock" ? 0 : 15_000, jobId: `textback-${tenantId}-${call.fromE164.replace(/\D/g, "")}-${Math.floor(ctx.now().getTime() / (12 * 3600_000))}` },
      );
    }
    return reply.code(204).send();
  });

  app.post("/twilio/voice/recording", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    const q = checkSignedQuery(ctx, req.query as Record<string, string>);
    if (q && f.RecordingUrl) await ctx.store.updateCall(q.tenantId, q.callId, { recordingUrl: f.RecordingUrl });
    return reply.code(204).send();
  });

  app.post("/twilio/voice/whisper", { preHandler: guard }, async (req, reply) => {
    const q = checkSignedQuery(ctx, req.query as Record<string, string>);
    const call = q ? await ctx.store.getCall(q.tenantId, q.callId) : null;
    const summary = call?.summary ? call.summary.split("; said:")[0] : "a customer call";
    return xml(reply, twiml(say(`Transfer from your A I receptionist: ${summary}. Connecting now.`)));
  });

  // <Dial action>: walk the on-call rota; when everyone fails, SMS + callback task.
  app.post("/twilio/voice/transfer-result", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    const query = req.query as Record<string, string>;
    const q = checkSignedQuery(ctx, query);
    if (!q) return reply.code(403).send("bad signature");
    const tenant = await ctx.store.getTenant(q.tenantId);
    const call = await ctx.store.getCall(q.tenantId, q.callId);
    if (!tenant || !call || !call.state) return xml(reply, sayHangupTwiml());
    const { session, effects } = newSession(ctx, tenant, call.id, { state: call.state as SessionState });
    const dialStatus = f.DialCallStatus ?? "failed";
    const index = Number(query.i ?? 0);
    const numbers = session.state.transfer?.numbers ?? [];
    await ctx.store.appendEvent(tenant.id, call.id, "transfer.dial_result", { index, number: numbers[index], dialStatus });
    if (dialStatus === "completed" || dialStatus === "answered") {
      await session.transferResult("connected");
      await persistSession(ctx, tenant.id, call.id, session);
      await effects.flush();
      return xml(reply, emptyTwiml());
    }
    if (index + 1 < numbers.length) {
      return xml(reply, transferDialTwiml(ctx, tenant, { callId: call.id, callerE164: call.fromE164, numbers, index: index + 1, sayFirst: "Still trying to reach someone, please hold." }));
    }
    const turn = await session.transferResult("failed");
    await ctx.store.appendTranscript(tenant.id, call.id, "agent", turn.say);
    await persistSession(ctx, tenant.id, call.id, session);
    await effects.flush();
    return xml(reply, sayHangupTwiml(turn.say));
  });
}
