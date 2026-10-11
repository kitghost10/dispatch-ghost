import { maySend } from "@sb/core";
import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";

export type SmsPurpose = "keyword_reply" | "missed_call" | "conversation_reply" | "booking_confirmation" | "oncall_alert";

export async function tenantFromNumber(ctx: AppContext, tenant: Tenant): Promise<string> {
  const numbers = await ctx.store.listPhoneNumbers(tenant.id);
  if (!numbers[0]) throw new Error(`tenant ${tenant.slug} has no phone number`);
  return numbers[0];
}

/**
 * Every outbound text goes through here: consent check, record, send, status.
 * Staff alerts (on-call) are not consumer messages and skip the consent table.
 */
export async function sendTenantSms(
  ctx: AppContext,
  tenant: Tenant,
  input: { to: string; body: string; purpose: SmsPurpose; conversationId?: string | null },
): Promise<{ status: "sent" | "skipped" | "failed"; reason?: string; id?: string }> {
  if (!tenant.config.sms.enabled && input.purpose !== "keyword_reply" && input.purpose !== "oncall_alert") return { status: "skipped", reason: "sms_disabled" };
  if (input.purpose !== "oncall_alert") {
    const consent = await ctx.store.getConsent(tenant.id, input.to);
    const kind = input.purpose === "keyword_reply" ? "keyword_reply" : input.purpose === "conversation_reply" ? "conversation_reply" : "transactional";
    if (!maySend(consent, kind)) return { status: "skipped", reason: `consent_${consent}` };
  }
  const from = await tenantFromNumber(ctx, tenant);
  const msg = await ctx.store.insertSms(tenant.id, {
    conversationId: input.conversationId ?? null,
    direction: "outbound",
    fromE164: from,
    toE164: input.to,
    body: input.body,
    purpose: input.purpose,
    status: "queued",
    providerSid: null,
  });
  try {
    const res = await ctx.telephony.sendSms({ from, to: input.to, body: input.body, statusCallback: `${ctx.env.PUBLIC_BASE_URL}/twilio/sms/status?tenantId=${encodeURIComponent(tenant.id)}&id=${encodeURIComponent(msg.id)}` });
    await ctx.store.updateSmsStatus(tenant.id, msg.id, res.status || "sent", res.sid);
    return { status: "sent", id: msg.id };
  } catch (err) {
    await ctx.store.updateSmsStatus(tenant.id, msg.id, "failed");
    ctx.log.error({ err, tenant: tenant.slug, purpose: input.purpose }, "sms send failed");
    // Re-throw so a queued job retries (BullMQ backoff).
    throw err;
  }
}
