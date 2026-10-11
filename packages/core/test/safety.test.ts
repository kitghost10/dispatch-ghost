import { describe, expect, it } from "vitest";
import { extractSafetyFlags } from "../src";

describe("extractSafetyFlags", () => {
  const hazards: Array<[string, string]> = [
    ["I smell gas near the water heater", "gas_odor"],
    ["there's a rotten egg smell in the basement", "gas_odor"],
    ["smells like natural gas in here", "gas_odor"],
    ["my carbon monoxide alarm is going off", "carbon_monoxide_alarm"],
    ["there is smoke coming from the water heater closet", "smoke_present"],
    ["flames under the water heater", "visible_fire"],
    ["the outlet is sparking", "active_sparks"],
    ["a pipe burst and water is pouring onto the electrical panel", "water_near_electrical"],
    ["the basement is flooding and it's up to the outlets", "water_near_electrical"],
    ["water is dripping from the light fixture", "water_near_electrical"],
    ["the breaker box is wet", "water_near_electrical"],
    ["my husband slipped and fell and he's bleeding", "injury_reported"],
    ["I got scalded by the shower", "injury_reported"],
    ["I'm not sure if it's safe to be in here", "caller_unsure_if_safe"],
  ];
  for (const [text, flag] of hazards) {
    it(`flags ${flag}: "${text}"`, () => {
      expect(extractSafetyFlags(text)).toContain(flag);
    });
  }

  const safe = [
    "no gas smell, just water",
    "I don't smell gas or anything",
    "there's no smoke or fire, just a leak",
    "the leak is not near any outlets",
    "my kitchen sink is clogged",
    "I need my fire sprinkler line looked at",
    "the plumber did a smoke test on our sewer last year",
    "my water heater is out and I have a baby",
    "it's an emergency, my toilet is running",
  ];
  for (const text of safe) {
    it(`no hazard: "${text}"`, () => {
      expect(extractSafetyFlags(text)).toEqual([]);
    });
  }
});
