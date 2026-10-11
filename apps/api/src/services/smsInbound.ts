import { classifyKeyword, helpReply, startReply, stopReply, type SessionState } from "@sb/core";
import type { AppContext } from "../context";
import { newSession, textTurn } from "./conversations";
import { persistSession } from "./persist";
import { sendTenantSms, tenantFromNumber } from "./sms";

const CONVERSATION_TTL_MS = 24 * 3600_000;

export async function handleInboundSms(ctx: AppContext, input: { tenantId: string; from: string; to: string; body: string; optOutType?: string; messageSid?: string }) {
  const tenant = await ctx.store.getTenant(input.tenantId);
  if (!tenant) return { reply: null as string | null, reason: "unknown_tenant" };
  const cfg = tenant.config;
  const conversation = await ctx.store.getOrCreateConversation(tenant.id, input.from);
  await ctx.store.insertSms(tenant.id, {
    conversationId: conversation.id, direction: "inbound", fromE164: input.from, toE164: input.to, body: input.body, purpose: "inbound", status: "received", providerSid: input.messageSid ?? null,
  });

  const kw = classifyKeyword(input.body, input.optOutType);
  if (kw) {
    const businessPhone = await tenantFromNumber(ctx, tenant);
    if (kw.kind === "stop") await ctx.store.setConsent(tenant.id, input.from, "opted_out", `keyword:${input.body.trim().toUpperCase().slice(0, 20)}`);
    if (kw.kind === "start") await ctx.store.setConsent(tenant.id, input.from, "granted", "keyword:START");
    // With Twilio Advanced Opt-Out, Twilio already sent the compliance reply.
    if (ctx.env.TWILIO_ADVANCED_OPT_OUT) return { reply: null, reason: `keyword_${kw.kind}_handled_by_twilio` };
    const body = kw.kind === "stop" ? stopReply(cfg) : kw.kind === "start" ? startReply(cfg) : helpReply(cfg, businessPhone);
    // keyword_reply is the one purpose allowed after opt-out (the STOP confirmation itself).
    await sendTenantSms(ctx, tenant, { to: input.from, body, purpose: "keyword_reply", conversationId: conversation.id });
    return { reply: body, reason: `keyword_${kw.kind}` };
  }

  if (!cfg.sms.enabled || tenant.status === "paused") return { reply: null, reason: "sms_disabled" };

  const consent = await ctx.store.getConsent(tenant.id, input.from);
  if (consent === "opted_out") return { reply: null, reason: "opted_out" };
  if (consent === "unknown") await ctx.store.setConsent(tenant.id, input.from, "implied", "inbound_sms");

  // Rehydrate or start the conversation's receptionist session.
  let state = conversation.state as SessionState | null;
  // Staleness uses the session's own clock (startedAt) so it is consistent with ctx.now().
  const stale = !state || state.ended || Math.abs(ctx.now().getTime() - new Date(state.startedAt).getTime()) > CONVERSATION_TTL_MS;
  let callId = conversation.callId;
  if (stale || !callId) {
    const call = await ctx.store.createCall(tenant.id, { fromE164: input.from, toE164: input.to, channel: "sms", afterHours: false, providerCallSid: null });
    callId = call.id;
    if (stale) state = null;
  }
  const { session, effects } = state ? newSession(ctx, tenant, callId, { state }) : newSession(ctx, tenant, callId, { channel: "sms", callerPhone: input.from });
  await ctx.store.updateCall(tenant.id, callId, { afterHours: session.state.afterHours });
  await ctx.store.appendTranscript(tenant.id, callId, "caller", input.body);

  if (!cfg.sms.aiReplies) {
    await session.scheduleCallback("sms_needs_reply", `Inbound text: "${input.body.slice(0, 200)}"`);
    await persistSession(ctx, tenant.id, callId, session);
    await ctx.store.saveConversationState(tenant.id, conversation.id, session.state, callId);
    await effects.flush();
    return { reply: null, reason: "ai_replies_disabled" };
  }

  const history = await ctx.store.listTranscript(tenant.id, callId);
  const turn = await textTurn(ctx, session, input.body, history.slice(0, -1), { allowLlm: true });
  if (turn.say) {
    await ctx.store.appendTranscript(tenant.id, callId, "agent", turn.say);
    await sendTenantSms(ctx, tenant, { to: input.from, body: turn.say, purpose: "conversation_reply", conversationId: conversation.id });
  }
  await persistSession(ctx, tenant.id, callId, session, session.state.ended ? { status: "completed", endedAt: ctx.now().toISOString() } : {});
  await ctx.store.saveConversationState(tenant.id, conversation.id, session.state, callId);
  await effects.flush();
  return { reply: turn.say, reason: turn.engine };
}
