import { describe, expect, it } from "vitest";
import { classifyIssue, determinePriority, extractStatedFacts, type CallFacts } from "../src";

function facts(partial: Partial<CallFacts>): CallFacts {
  return { issue: "unknown", description: [], safetyFlags: [], ...partial };
}

describe("classifyIssue", () => {
  const cases: Array<[string, string]> = [
    ["a pipe burst in my garage", "burst_pipe"],
    ["the water main broke", "burst_pipe"],
    ["sewage is backing up into my tub", "sewage_backup"],
    ["my basement is flooding", "flooding"],
    ["we have no water at all in the house", "no_water"],
    ["no hot water since this morning", "no_hot_water"],
    ["my water heater is leaking all over the garage", "water_heater_leak"],
    ["water leaking under the kitchen sink", "active_leak"],
    ["my kitchen drain is clogged", "clogged_drain"],
    ["toilet is clogged and won't flush", "toilet_clog"],
    ["toilet keeps running all night", "running_toilet"],
    ["my air conditioner stopped working", "not_offered"],
    ["I need a gas line run to my new stove", "gas_line_work"],
  ];
  for (const [text, issue] of cases) {
    it(`${issue}: "${text}"`, () => expect(classifyIssue(text, ["hvac", "air conditioning", "gas line", "roofing"])).toBe(issue));
  }
});

describe("determinePriority", () => {
  it("any safety flag is P0 and never schedulable", () => {
    const d = determinePriority(facts({ issue: "burst_pipe", safetyFlags: ["water_near_electrical"] }));
    expect(d.priority).toBe("P0");
    expect(d.schedulable).toBe(false);
    expect(d.reasonCodes).toContain("SAFETY_FLAG:WATER_NEAR_ELECTRICAL");
  });

  it("gas beats a routine issue", () => {
    expect(determinePriority(facts({ issue: "clogged_drain", safetyFlags: ["gas_odor"] })).priority).toBe("P0");
  });

  it("burst pipe is P1", () => {
    expect(determinePriority(facts({ issue: "burst_pipe" })).priority).toBe("P1");
  });

  it("uncontrolled leak without a known shut-off is P1; contained leak is P2", () => {
    expect(determinePriority(facts({ issue: "active_leak", waterFlowing: true, shutoffLocated: false })).priority).toBe("P1");
    expect(determinePriority(facts({ issue: "active_leak", waterFlowing: false })).priority).toBe("P2");
    expect(determinePriority(facts({ issue: "active_leak", waterFlowing: true, shutoffClosed: true })).priority).toBe("P2");
  });

  it("sewage in the living area is P1, not in home is P2", () => {
    expect(determinePriority(facts({ issue: "sewage_backup", sewageInHome: true })).priority).toBe("P1");
    expect(determinePriority(facts({ issue: "sewage_backup", sewageInHome: false })).priority).toBe("P2");
  });

  it("no water in the whole home is P1; single fixture is P3", () => {
    expect(determinePriority(facts({ issue: "no_water" })).priority).toBe("P1");
    expect(determinePriority(facts({ issue: "no_water", wholeHomeNoWater: false })).priority).toBe("P3");
  });

  it("no hot water is P2; infant adds a reason code and optional P1 upgrade", () => {
    const d = determinePriority(facts({ issue: "no_hot_water", vulnerableOccupant: true }));
    expect(d.priority).toBe("P2");
    expect(d.reasonCodes).toContain("CONTEXT:VULNERABLE_OCCUPANT");
    expect(determinePriority(facts({ issue: "no_hot_water", vulnerableOccupant: true }), { vulnerableOccupantUpgradesToP1: true }).priority).toBe("P1");
  });

  it("the caller's word 'emergency' never changes priority", () => {
    const d = determinePriority(facts({ issue: "garbage_disposal", callerSaidEmergency: true }));
    expect(d.priority).toBe("P3");
    expect(d.reasonCodes).toContain("NOTE:CALLER_SAID_EMERGENCY_NOT_USED_FOR_PRIORITY");
  });

  it("only toilet clogged is same-day", () => {
    expect(determinePriority(facts({ issue: "toilet_clog", onlyToilet: true })).priority).toBe("P2");
    expect(determinePriority(facts({ issue: "toilet_clog", onlyToilet: false })).priority).toBe("P3");
  });

  it("asks the electrical question first for water issues", () => {
    const d = determinePriority(facts({ issue: "burst_pipe" }));
    expect(d.openQuestions[0]?.key).toBe("nearElectrical");
    expect(d.openQuestions.map((q) => q.key)).toEqual(["nearElectrical", "waterFlowing", "shutoffLocated"]);
  });

  it("asks about gas near a water heater", () => {
    const d = determinePriority(facts({ issue: "no_hot_water" }));
    expect(d.openQuestions.map((q) => q.key)).toContain("gasSmellCheck");
  });
});

describe("extractStatedFacts", () => {
  it("reads flow and shut-off statements", () => {
    expect(extractStatedFacts("it's still pouring out")).toMatchObject({ waterFlowing: true });
    expect(extractStatedFacts("I turned off the main")).toMatchObject({ waterFlowing: false, shutoffClosed: true });
    expect(extractStatedFacts("I can't find the shut off")).toMatchObject({ shutoffLocated: false });
    expect(extractStatedFacts("we have a newborn at home")).toMatchObject({ vulnerableOccupant: true });
  });
});

describe("classifier regressions found by the scenario suite", () => {
  it("routine faucet drip stays routine", () => {
    expect(classifyIssue("my bathroom faucet has been dripping for a week")).toBe("dripping_faucet");
    expect(classifyIssue("how much do you charge to fix a leaky faucet?")).toBe("dripping_faucet");
  });
  it("burst water heater and pouring water are recognised", () => {
    expect(classifyIssue("water heater burst and water is pouring into the garage")).toBe("flooding");
    expect(classifyIssue("the water heater burst")).toBe("water_heater_leak");
    expect(classifyIssue("water is pouring into the basement")).toBe("flooding");
  });
  it("a negated trade mention is not a not-offered request", () => {
    expect(classifyIssue("no electrical anywhere near it", ["electrical"])).toBe("unknown");
    expect(classifyIssue("my AC unit is broken", ["hvac"])).toBe("not_offered");
  });
});
