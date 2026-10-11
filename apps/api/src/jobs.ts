import { resolveOnCall } from "@sb/core";
import type { AppContext } from "./context";
import type { Processor } from "./queue";
import { missedCallTextBack } from "./services/missedCall";
import { sendTenantSms, type SmsPurpose } from "./services/sms";

export function makeProcessor(ctx: AppContext): Processor {
  return async (name, data) => {
    const tenantId = String(data.tenantId);
    switch (name) {
      case "sms.send": {
        const tenant = await ctx.store.getTenant(tenantId);
        if (!tenant) return;
        await sendTenantSms(ctx, tenant, { to: String(data.to), body: String(data.body), purpose: data.purpose as SmsPurpose, conversationId: (data.conversationId as string | undefined) ?? null });
        return;
      }
      case "missed-call.textback":
        await missedCallTextBack(ctx, { tenantId, callId: (data.callId as string | null) ?? null, phone: String(data.phone) });
        return;
      case "callbacks.sweep":
        await sweepOverdueCallbacks(ctx);
        return;
      case "booking.sync": {
        const tenant = await ctx.store.getTenant(tenantId);
        if (!tenant) return;
        const booking = (await ctx.store.listBookings(tenantId, { limit: 1000 })).find((b) => b.id === data.bookingId);
        if (!booking) return;
        const cfg = tenant.config;
        if (cfg.calendar.provider === "google" && cfg.calendar.calendarId && ctx.calendar && !booking.calendarEventId) {
          const ev = await ctx.calendar.createEvent({
            calendarId: cfg.calendar.calendarId,
            start: new Date(booking.startsAt),
            end: new Date(booking.endsAt),
            summary: `[${booking.priority}] ${booking.serviceKey.replace(/_/g, " ")} — ${booking.customerName}`,
            description: `${booking.problem}\nPhone: ${booking.customerPhone}\nArrival window: ${booking.windowLabel}\nBooked by AI receptionist.`,
            location: booking.address,
            timezone: cfg.timezone,
          });
          await ctx.store.updateBooking(tenantId, booking.id, { calendarEventId: ev.id });
        }
        const adapter = ctx.fsm[cfg.fieldService.provider];
        if (cfg.fieldService.provider !== "none" && !booking.fsmRef) {
          if (!adapter.enabled) {
            ctx.log.info({ tenant: tenant.slug, provider: adapter.name }, "field-service adapter disabled by flag; skipping sync");
            return;
          }
          const res = await adapter.createJob({
            tenantSettings: cfg.fieldService.settings, customerName: booking.customerName, customerPhone: booking.customerPhone, address: booking.address,
            zip: booking.zip, problem: booking.problem, priority: booking.priority, serviceKey: booking.serviceKey,
            start: new Date(booking.startsAt), end: new Date(booking.endsAt), externalId: booking.id,
          });
          await ctx.store.updateBooking(tenantId, booking.id, { fsmProvider: res.provider, fsmRef: res.ref });
        }
        return;
      }
    }
  };
}

/**
 * Re-alert on-call (rota + fallback + office) once when an urgent (P0/P1)
 * callback passes its due time without being marked done.
 */
export async function sweepOverdueCallbacks(ctx: AppContext): Promise<number> {
  const due = await ctx.store.overdueUrgentCallbacks(ctx.now());
  let escalated = 0;
  for (const { tenantId, id } of due) {
    const [tenant, cb] = await Promise.all([ctx.store.getTenant(tenantId), ctx.store.getCallback(tenantId, id)]);
    if (!tenant || !cb || cb.status !== "open" || cb.escalatedAt) continue;
    const cfg = tenant.config;
    const recipients = [...resolveOnCall(cfg, ctx.now())];
    for (const extra of [cfg.onCall.fallbackPhone, cfg.transfer.officeNumber]) {
      if (extra && !recipients.some((r) => r.phone === extra)) recipients.push({ name: extra === cfg.transfer.officeNumber ? "Office" : "Fallback", phone: extra });
    }
    const mins = Math.round((ctx.now().getTime() - new Date(cb.dueAt).getTime()) / 60000);
    const body = `[${cfg.brand.companyName}] OVERDUE ${cb.priority} CALLBACK (${mins} min late): call ${cb.name ? `${cb.name} ` : ""}${cb.callerPhone} back now. ${cb.notes}`.slice(0, 600);
    await ctx.store.markCallbackEscalated(tenantId, id);
    await ctx.store.insertAlert(tenantId, { callId: cb.callId, priority: cb.priority, reason: "callback_overdue", recipients, body, status: recipients.length ? "queued" : "no_recipients" });
    for (const r of recipients) await ctx.queue.enqueue("sms.send", { tenantId, to: r.phone, body, purpose: "oncall_alert" });
    escalated++;
  }
  return escalated;
}
