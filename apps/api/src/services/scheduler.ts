import { findSlots, type BookingRequest, type BookingResult, type Scheduler, type Slot } from "@sb/core";
import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";

async function busyIntervals(ctx: AppContext, tenant: Tenant, from: Date, to: Date) {
  const bookings = await ctx.store.listBookings(tenant.id, { from, to });
  const busy = bookings.filter((b) => b.status === "booked").map((b) => ({ start: new Date(b.startsAt), end: new Date(b.endsAt) }));
  const cal = tenant.config.calendar;
  if (cal.provider === "google" && cal.calendarId && ctx.calendar) {
    try {
      // Events we created ourselves are already in `bookings`; counting them twice
      // would halve capacity, so only foreign events are added.
      const ours = new Set(bookings.map((b) => `${b.startsAt}|${b.endsAt}`));
      for (const b of await ctx.calendar.busy(cal.calendarId, from, to)) {
        if (!ours.has(`${b.start.toISOString()}|${b.end.toISOString()}`)) busy.push(b);
      }
    } catch (err) {
      ctx.log.warn({ err, tenant: tenant.slug }, "calendar busy lookup failed; using bookings only");
    }
  }
  return busy;
}

export function makeScheduler(ctx: AppContext, tenant: Tenant, callId: string | null): Scheduler {
  const config = tenant.config;
  return {
    async findSlots({ serviceKey, priority, limit }): Promise<Slot[]> {
      const service = config.services.find((s) => s.key === serviceKey);
      if (!service) return [];
      const now = ctx.now();
      const to = new Date(now.getTime() + (config.booking.horizonDays + 1) * 86400_000);
      const busy = await busyIntervals(ctx, tenant, now, to);
      return findSlots({ config, service, now, busy, priority, ...(limit ? { limit } : {}) });
    },
    async book(req: BookingRequest): Promise<BookingResult> {
      if (req.priority === "P0") return { ok: false, reason: "life_safety_not_schedulable" };
      const created = await ctx.store.createBookingIfCapacity(
        tenant.id,
        {
          callId,
          serviceKey: req.serviceKey,
          priority: req.priority,
          startsAt: req.slot.start,
          endsAt: req.slot.end,
          windowLabel: req.slot.spoken,
          customerName: req.customer.name,
          customerPhone: req.customer.phone,
          address: req.customer.address ?? "",
          zip: req.customer.zip ?? null,
          problem: req.problem,
          smsConsent: req.customer.smsConsent === true,
          calendarEventId: null,
          fsmProvider: null,
          fsmRef: null,
        },
        config.booking.capacity,
      );
      if (!created) return { ok: false, reason: "slot_taken" };
      await ctx.queue.enqueue("booking.sync", { tenantId: tenant.id, bookingId: created.id }, { jobId: `booking-sync-${created.id}` });
      return { ok: true, bookingId: created.id };
    },
  };
}
