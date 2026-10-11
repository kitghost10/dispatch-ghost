import { initialState, missedCallText } from "@sb/core";
import type { AppContext } from "../context";
import { sendTenantSms } from "./sms";

const RECENT_MS = 12 * 3600_000;

/** Text back a caller we missed (hung up before speaking, no-answer, busy, failed). */
export async function missedCallTextBack(ctx: AppContext, input: { tenantId: string; callId: string | null; phone: string }) {
  const tenant = await ctx.store.getTenant(input.tenantId);
  if (!tenant) return;
  const cfg = tenant.config;
  const record = (status: "sent" | "skipped" | "failed", reason: string | null) =>
    ctx.store.insertMissedCallText(tenant.id, { callId: input.callId, phone: input.phone, status, reason });
  if (!cfg.sms.enabled || !cfg.sms.missedCallTextBack) return record("skipped", "disabled");
  if (!/^\+1\d{10}$/.test(input.phone)) return record("skipped", "non_us_or_invalid_number");
  const consent = await ctx.store.getConsent(tenant.id, input.phone);
  if (consent === "opted_out") return record("skipped", "opted_out");
  const recent = (await ctx.store.listMissedCallTexts(tenant.id, 50)).find(
    (m) => m.phone === input.phone && m.status === "sent" && ctx.now().getTime() - new Date(m.createdAt).getTime() < RECENT_MS,
  );
  if (recent) return record("skipped", "texted_recently");
  if (consent === "unknown") await ctx.store.setConsent(tenant.id, input.phone, "implied", "inbound_call");

  const conversation = await ctx.store.getOrCreateConversation(tenant.id, input.phone);
  const state = initialState(cfg, { channel: "sms", callerPhone: input.phone, now: ctx.now() });
  state.pendingQuestion = "issue";
  await ctx.store.saveConversationState(tenant.id, conversation.id, state, null);
  try {
    const res = await sendTenantSms(ctx, tenant, { to: input.phone, body: missedCallText(cfg), purpose: "missed_call", conversationId: conversation.id });
    return record(res.status === "sent" ? "sent" : "skipped", res.reason ?? null);
  } catch (err) {
    await record("failed", err instanceof Error ? err.message.slice(0, 200) : "send_failed");
    throw err;
  }
}
