import { PRIORITY_SLA_MINUTES, type EffectSink } from "@sb/core";
import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";

/**
 * Side effects for one call/conversation. `simulated` (dashboard simulator)
 * records everything but never texts real people.
 */
export function makeEffects(ctx: AppContext, tenant: Tenant, callId: string, opts: { simulated?: boolean } = {}): EffectSink & { flush(): Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  const later = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).catch((err) => ctx.log.error({ err, callId }, "call event write failed"));
  };
  return {
    async alertOnCall(a) {
      const body = `[${tenant.config.brand.companyName}] ${a.priority} ${a.reason.replace(/_/g, " ").toUpperCase()}: ${a.summary}`.slice(0, 600);
      const recipients = a.recipients.length ? a.recipients : tenant.config.onCall.fallbackPhone ? [{ name: "On-call", phone: tenant.config.onCall.fallbackPhone }] : [];
      await ctx.store.insertAlert(tenant.id, {
        callId,
        priority: a.priority,
        reason: a.reason,
        recipients,
        body,
        status: opts.simulated ? "simulated" : recipients.length ? "queued" : "no_recipients",
      });
      if (opts.simulated) return;
      for (const r of recipients) {
        await ctx.queue.enqueue("sms.send", { tenantId: tenant.id, to: r.phone, body, purpose: "oncall_alert" });
      }
    },
    async createCallback(t) {
      await ctx.store.createCallback(tenant.id, {
        callId,
        priority: t.priority,
        reason: t.reason,
        callerPhone: t.callerPhone,
        name: t.name ?? null,
        notes: t.notes,
        dueAt: new Date(ctx.now().getTime() + Math.min(t.dueInMinutes, PRIORITY_SLA_MINUTES[t.priority] * 4) * 60_000).toISOString(),
      });
    },
    async sendConfirmationSms(m) {
      if (opts.simulated) return;
      await ctx.store.setConsent(tenant.id, m.to, "granted", "voice_booking_consent");
      await ctx.queue.enqueue("sms.send", { tenantId: tenant.id, to: m.to, body: m.body, purpose: "booking_confirmation" });
    },
    event(e) {
      later(() => ctx.store.appendEvent(tenant.id, callId, e.type, { at: e.at, ...(e.data ?? {}) }));
    },
    async flush() {
      await chain;
    },
  };
}
