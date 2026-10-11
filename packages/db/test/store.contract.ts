import { describe, expect, it } from "vitest";
import { demoTenantConfig } from "@sb/core";
import type { Store } from "../src";

/** Behaviour both stores must share. */
export function storeContract(name: string, make: () => Promise<Store>) {
  describe(`${name} store contract`, () => {
    it("tenants, numbers and calls round-trip", async () => {
      const store = await make();
      const config = demoTenantConfig();
      const slug = `t-${Math.random().toString(36).slice(2, 8)}`;
      const t = await store.createTenant({ slug, name: "Acme Plumbing", config });
      const number = `+1512555${Math.floor(1000 + Math.random() * 8999)}`;
      await store.addPhoneNumber(t.id, number);
      expect(await store.resolveTenantByNumber(number)).toBe(t.id);
      expect(await store.listPhoneNumbers(t.id)).toContain(number);
      expect((await store.setTenantStatus(t.id, "active")).status).toBe("active");
      const call = await store.createCall(t.id, { fromE164: "+15125559876", toE164: number, channel: "voice", afterHours: false, providerCallSid: `CA${slug}` });
      await store.appendTranscript(t.id, call.id, "caller", "my pipe burst");
      await store.appendEvent(t.id, call.id, "triage.updated", { priority: "P1" });
      const updated = await store.updateCall(t.id, call.id, { priority: "P1", issue: "burst_pipe", safetyFlags: [], reasonCodes: ["ISSUE:BURST_PIPE"], state: { a: 1 } });
      expect(updated.priority).toBe("P1");
      expect((await store.getCallBySid(t.id, `CA${slug}`))?.id).toBe(call.id);
      expect(await store.listTranscript(t.id, call.id)).toHaveLength(1);
      expect((await store.listEvents(t.id, call.id))[0]?.type).toBe("triage.updated");
      expect((await store.listCalls(t.id, { priority: "P1" })).map((c) => c.id)).toContain(call.id);
      const b = await store.createBooking(t.id, {
        callId: call.id, serviceKey: "drain_cleaning", priority: "P3", startsAt: "2026-10-01T15:00:00.000Z", endsAt: "2026-10-01T16:30:00.000Z",
        windowLabel: "Thursday between 10 and 12", customerName: "Pat Doe", customerPhone: "+15125559876", address: "1 Main St", zip: "78704",
        problem: "clog", smsConsent: true, calendarEventId: null, fsmProvider: null, fsmRef: null,
      });
      const clash = { ...b, callId: null, status: undefined };
      const cap1 = await store.createBookingIfCapacity(t.id, { ...clash, id: undefined } as never, 1);
      expect(cap1).toBeNull();
      const cap2 = await store.createBookingIfCapacity(t.id, { ...clash, id: undefined } as never, 2);
      expect(cap2?.id).toBeTruthy();
      await store.updateBooking(t.id, b.id, { fsmProvider: "servicetitan", fsmRef: "dry-run-1" });
      const bookings = await store.listBookings(t.id, { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z") });
      expect(bookings.find((x) => x.id === b.id)?.fsmRef).toBe("dry-run-1");
      expect(bookings).toHaveLength(2);
      const stats = await store.stats(t.id, new Date());
      expect(stats.calls7d).toBeGreaterThanOrEqual(1);
    });

    it("sms consent, conversations, callbacks and alerts", async () => {
      const store = await make();
      const t = await store.createTenant({ slug: `s-${Math.random().toString(36).slice(2, 8)}`, name: "SMS Co", config: demoTenantConfig() });
      expect(await store.getConsent(t.id, "+15125550000")).toBe("unknown");
      await store.setConsent(t.id, "+15125550000", "opted_out", "keyword:STOP");
      expect(await store.getConsent(t.id, "+15125550000")).toBe("opted_out");
      const conv = await store.getOrCreateConversation(t.id, "+15125550000");
      expect((await store.getOrCreateConversation(t.id, "+15125550000")).id).toBe(conv.id);
      await store.saveConversationState(t.id, conv.id, { hello: "world" });
      expect((await store.getOrCreateConversation(t.id, "+15125550000")).state).toEqual({ hello: "world" });
      const m = await store.insertSms(t.id, { conversationId: conv.id, direction: "outbound", fromE164: "+15125550199", toE164: "+15125550000", body: "hi", purpose: "missed_call", status: "queued", providerSid: null });
      await store.updateSmsStatus(t.id, m.id, "sent", "SM123");
      expect((await store.listSms(t.id, { phone: "+15125550000" }))[0]?.providerSid).toBe("SM123");
      await store.insertMissedCallText(t.id, { callId: null, phone: "+15125550000", status: "sent", reason: null });
      expect(await store.listMissedCallTexts(t.id)).toHaveLength(1);
      const cb = await store.createCallback(t.id, { callId: null, priority: "P1", reason: "transfer_failed", callerPhone: "+15125550000", name: null, notes: "x", dueAt: new Date().toISOString() });
      expect(await store.listCallbacks(t.id, { status: "open" })).toHaveLength(1);
      await store.completeCallback(t.id, cb.id);
      expect(await store.listCallbacks(t.id, { status: "open" })).toHaveLength(0);
      await store.insertAlert(t.id, { callId: null, priority: "P1", reason: "transfer_failed", recipients: [{ name: "M", phone: "+15125550111" }], body: "b", status: "sent" });
      expect((await store.listAlerts(t.id))[0]?.recipients[0]?.phone).toBe("+15125550111");
    });

    it("users and memberships", async () => {
      const store = await make();
      const email = `u${Math.random().toString(36).slice(2, 8)}@Example.com`;
      const u = await store.createUser({ email, passwordHash: "x" });
      expect((await store.findUserByEmail(email))?.id).toBe(u.id);
      const t = await store.createTenant({ slug: `m-${Math.random().toString(36).slice(2, 8)}`, name: "M Co", config: demoTenantConfig() });
      await store.addMembership({ userId: u.id, tenantId: t.id, role: "owner" });
      expect(await store.listMemberships(u.id)).toEqual([{ userId: u.id, tenantId: t.id, role: "owner" }]);
    });
  });
}
