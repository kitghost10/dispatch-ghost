import { describe, expect, it } from "vitest";
import { demoTenantConfig, executeTool, findUnapprovedPrices } from "../src";
import { harness } from "./helpers";

const config = demoTenantConfig();
const TUE_10AM = new Date("2026-09-29T15:00:00Z");
const TUE_1130PM = new Date("2026-09-30T04:30:00Z");

describe("ReceptionistSession safety lockout", () => {
  it("a hazard mentioned mid-booking stops the booking", async () => {
    const h = harness(config, TUE_10AM);
    await h.say("my kitchen drain is clogged");
    await h.say("78704");
    const turn = await h.say("oh wait, I also smell gas in the kitchen");
    expect(turn.say).toMatch(/get everyone out/);
    expect(turn.actions).toContainEqual({ type: "hangup", reason: "life_safety" });
    expect(h.session.state.outcome).toBe("safety_evacuate");
    expect(await h.session.offerSlots()).toEqual({ ok: false, reason: "life_safety_not_schedulable" });
    expect(h.bookings).toHaveLength(0);
    expect(h.alerts[0]?.priority).toBe("P0");
  });

  it("LLM tools refuse to book once P0", async () => {
    const h = harness(config, TUE_10AM);
    await executeTool(h.session, "record_facts", { issue: "clogged_drain" });
    await executeTool(h.session, "check_service_area", { zip: "78704" });
    const slots = await executeTool(h.session, "find_availability", {});
    const slotId = (slots.output.slots as Array<{ slotId: string }>)[0]!.slotId;
    const gas = await executeTool(h.session, "record_facts", { gasSmell: true });
    expect(gas.output.lifeSafety).toBe(true);
    const book = await executeTool(h.session, "book_appointment", { slotId, name: "A B", address: "1 Main St 78704", adultPresent: true, smsConsent: false });
    expect(book.output.ok).toBe(false);
    expect(book.output.error).toBe("life_safety_lockout");
    expect(h.bookings).toHaveLength(0);
  });

  it("LLM tools enforce service area and adult-on-site", async () => {
    const h = harness(config, TUE_10AM);
    await executeTool(h.session, "record_facts", { issue: "clogged_drain" });
    const early = await executeTool(h.session, "find_availability", {});
    expect(early.output.reason).toBe("service_area_not_checked");
    await executeTool(h.session, "check_service_area", { zip: "78704" });
    const slots = await executeTool(h.session, "find_availability", {});
    const slotId = (slots.output.slots as Array<{ slotId: string }>)[0]!.slotId;
    const minor = await executeTool(h.session, "book_appointment", { slotId, name: "A B", address: "1 Main St", adultPresent: false, smsConsent: false });
    expect(minor.output.reason).toBe("adult_required");
    const ok = await executeTool(h.session, "book_appointment", { slotId, name: "A B", address: "1 Main St", adultPresent: true, smsConsent: true });
    expect(ok.output.ok).toBe(true);
    expect(h.sms).toHaveLength(1);
    const repeated = await executeTool(h.session, "book_appointment", { slotId, name: "A B", address: "1 Main St", adultPresent: true, smsConsent: true });
    expect(repeated.output.bookingId).toBe(ok.output.bookingId);
    expect(h.bookings).toHaveLength(1);
    expect(h.sms).toHaveLength(1);
  });

  it("the scripted agent never says an unapproved price", async () => {
    const h = harness(config, TUE_10AM);
    await h.say("how much do you charge to snake a drain?");
    await h.say("my bathroom sink is clogged, come on give me a ballpark");
    await h.say("seriously how much");
    for (const line of h.transcript.filter((t) => t.role === "agent")) {
      expect(findUnapprovedPrices(line.text, config)).toEqual([]);
    }
  });

  it("after hours P1 on SMS alerts on-call and creates a callback (no transfer possible)", async () => {
    const h = harness(config, TUE_1130PM, "sms");
    await h.say("a pipe burst in the laundry room, 78702");
    await h.say("no, nowhere near electrical");
    await h.say("yes it's still spraying");
    const turn = await h.say("I don't know where the shut off is");
    expect(turn.actions.find((a) => a.type === "transfer")).toBeUndefined();
    expect(h.alerts).toHaveLength(1);
    expect(h.callbacks[0]?.priority).toBe("P1");
  });
});
