import { describe, expect, it } from "vitest";
import {
  checkServiceArea,
  classifyKeyword,
  demoTenantConfig,
  extractZip,
  findSlots,
  findUnapprovedPrices,
  inQuietHours,
  isOpen,
  isPriceQuestion,
  maySend,
  noQuoteStatement,
  parseTenantConfig,
  resolveOnCall,
  tripFeeStatement,
  createTenantFromTemplate,
  DEMO_ANSWERS,
} from "../src";

const config = demoTenantConfig();
// Tuesday 2026-09-29 10:00 America/Chicago = 15:00Z
const TUE_10AM = new Date("2026-09-29T15:00:00Z");
// Tuesday 2026-09-29 23:30 America/Chicago = 04:30Z Wed
const TUE_1130PM = new Date("2026-09-30T04:30:00Z");

describe("tenant config", () => {
  it("demo template validates", () => {
    expect(config.brand.companyName).toBe("Lone Star Rapid Plumbing");
    expect(config.services.length).toBeGreaterThan(3);
  });
  it("rejects a tenant without a service area", () => {
    expect(() => createTenantFromTemplate({ ...DEMO_ANSWERS, serviceArea: { zips: [] } })).toThrow();
  });
  it("rejects bad phone numbers", () => {
    expect(() => parseTenantConfig({ ...config, transfer: { ...config.transfer, officeNumber: "512-555-0100" } })).toThrow();
  });
});

describe("pricing", () => {
  it("states the trip fee and credit", () => {
    const s = tripFeeStatement(config, false);
    expect(s).toContain("$89");
    expect(s).toContain("credited");
  });
  it("uses the after-hours fee after hours", () => {
    expect(tripFeeStatement(config, true)).toContain("$149");
  });
  it("never quotes a repair price", () => {
    const s = noQuoteStatement(config);
    expect(findUnapprovedPrices(s, config)).toEqual([]);
    expect(s).toMatch(/can't quote/);
  });
  it("starting-at prices only when enabled", () => {
    const svc = { ...config.services[2]!, startingAtPrice: 129 };
    expect(noQuoteStatement(config, svc)).not.toContain("$129");
    const withPrices = { ...config, pricing: { ...config.pricing, allowStartingAtPrices: true }, services: config.services.map((s) => (s.key === svc.key ? svc : s)) };
    expect(noQuoteStatement(withPrices, svc)).toContain("start at $129");
    expect(findUnapprovedPrices("jobs start at $129", withPrices)).toEqual([]);
  });
  it("output guard catches invented prices", () => {
    expect(findUnapprovedPrices("that usually runs about $350 to $500", config)).toEqual([350, 500]);
    expect(findUnapprovedPrices("the service call is $89", config)).toEqual([]);
  });
  it("detects price questions", () => {
    expect(isPriceQuestion("how much to unclog a drain?")).toBe(true);
    expect(isPriceQuestion("come on, just give me a ballpark")).toBe(true);
    expect(isPriceQuestion("my sink is clogged")).toBe(false);
  });
});

describe("service area", () => {
  it("extracts typed and spoken ZIPs", () => {
    expect(extractZip("I'm in 78704")).toBe("78704");
    expect(extractZip("seven eight seven oh four")).toBe("78704");
    expect(extractZip("call me at 512 555 0100")).toBeUndefined();
  });
  it("accepts listed zips and rejects others", async () => {
    expect((await checkServiceArea(config, { zip: "78704" })).inArea).toBe(true);
    const out = await checkServiceArea(config, { zip: "77002" });
    expect(out.inArea).toBe(false);
  });
  it("supports a radius with a geocoder", async () => {
    const radiusCfg = { ...config, serviceArea: { zips: [], description: "", radius: { centerLat: 30.2672, centerLng: -97.7431, miles: 25 } } };
    const geocoder = { geocode: async (q: string) => (q.includes("78664") ? { lat: 30.5083, lng: -97.6789, zip: "78664" } : { lat: 29.7604, lng: -95.3698 }) };
    expect((await checkServiceArea(radiusCfg, { zip: "78664" }, geocoder)).inArea).toBe(true);
    expect((await checkServiceArea(radiusCfg, { zip: "77002" }, geocoder)).inArea).toBe(false);
  });
});

describe("hours, on-call and slots", () => {
  it("knows office hours", () => {
    expect(isOpen(config, TUE_10AM)).toBe(true);
    expect(isOpen(config, TUE_1130PM)).toBe(false);
  });
  it("holidays are after hours", () => {
    expect(isOpen({ ...config, holidays: ["2026-09-29"] }, TUE_10AM)).toBe(false);
  });
  it("resolves the on-call rota in order", () => {
    expect(resolveOnCall(config, TUE_1130PM).map((p) => p.phone)).toEqual(["+15125550111", "+15125550112"]);
  });
  it("falls back when no shift matches", () => {
    const cfg = { ...config, onCall: { ...config.onCall, shifts: [] } };
    expect(resolveOnCall(cfg, TUE_1130PM)).toEqual([{ name: "On-call", phone: "+15125550113" }]);
  });
  it("offers arrival windows respecting lead time and capacity", () => {
    const svc = config.services.find((s) => s.key === "drain_cleaning")!;
    const slots = findSlots({ config, service: svc, now: TUE_10AM, busy: [], priority: "P3" });
    expect(slots).toHaveLength(3);
    expect(slots[0]!.spoken).toMatch(/^today between 11 AM and 1 PM$/);
    const busy = [
      { start: new Date(slots[0]!.start), end: new Date(slots[0]!.end) },
      { start: new Date(slots[0]!.start), end: new Date(slots[0]!.end) },
    ];
    const next = findSlots({ config, service: svc, now: TUE_10AM, busy, priority: "P3" });
    expect(next[0]!.id).not.toBe(slots[0]!.id);
  });
  it("P2 offers today first", () => {
    const svc = config.services.find((s) => s.key === "water_heater")!;
    const slots = findSlots({ config, service: svc, now: TUE_10AM, busy: [], priority: "P2" });
    expect(slots.every((s) => s.spoken.startsWith("today"))).toBe(true);
  });
  it("after-hours routine gets next business day", () => {
    const svc = config.services.find((s) => s.key === "drain_cleaning")!;
    const slots = findSlots({ config, service: svc, now: TUE_1130PM, busy: [], priority: "P3" });
    expect(slots[0]!.spoken).toMatch(/^tomorrow between 7 AM and 9 AM$/);
  });
});

describe("sms policy", () => {
  it("classifies keywords", () => {
    expect(classifyKeyword("STOP")).toEqual({ kind: "stop" });
    expect(classifyKeyword("stop.")).toEqual({ kind: "stop" });
    expect(classifyKeyword("Unsubscribe")).toEqual({ kind: "stop" });
    expect(classifyKeyword("help")).toEqual({ kind: "help" });
    expect(classifyKeyword("START")).toEqual({ kind: "start" });
    expect(classifyKeyword("please don't stop by after 5pm")).toBeNull();
    expect(classifyKeyword("anything", "STOP")).toEqual({ kind: "stop" });
  });
  it("never sends to opted-out numbers except keyword replies", () => {
    expect(maySend("opted_out", "transactional")).toBe(false);
    expect(maySend("opted_out", "keyword_reply")).toBe(true);
    expect(maySend("implied", "marketing")).toBe(false);
    expect(maySend("implied", "transactional")).toBe(true);
  });
  it("quiet hours", () => {
    expect(inQuietHours(config, TUE_1130PM)).toBe(true);
    expect(inQuietHours(config, TUE_10AM)).toBe(false);
  });
});
