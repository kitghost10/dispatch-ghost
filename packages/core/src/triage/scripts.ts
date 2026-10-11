/**
 * Approved safety language. Said verbatim; the model is instructed to read the
 * tool's `mustSay` text and the gateway injects it directly if the model does not.
 *
 * Wording follows utility-published guidance (evacuate, no switches/flames,
 * call from outside) and HomeGuard's approved P0 response, attributed as
 * standard guidance rather than the agent's opinion (open-receptionist).
 */
import type { SafetyFlag } from "./types";

export interface SafetyScript {
  kind: "gas" | "fire_smoke" | "electrical_water" | "medical" | "general";
  text: string;
}

export function safetyScriptFor(flags: SafetyFlag[], gasUtilityLine?: string): SafetyScript {
  const utility = gasUtilityLine ? ` — ${gasUtilityLine}` : "";
  if (flags.includes("gas_odor") || flags.includes("carbon_monoxide_alarm")) {
    return {
      kind: "gas",
      text:
        `This is a safety emergency, and the standard guidance is clear: please get everyone out of the house right now. ` +
        `Don't flip any light switches, don't use anything that could make a spark, and leave the door open behind you. ` +
        `Once you're outside and away from the house, call 911 and your gas company's emergency line${utility}. ` +
        `We can't send a plumber until the gas company says it's safe. I'm letting our on-call team know right now.`,
    };
  }
  if (flags.includes("visible_fire") || flags.includes("smoke_present") || flags.includes("burning_smell") || flags.includes("active_sparks")) {
    return {
      kind: "fire_smoke",
      text:
        "This is a safety emergency. Please get everyone out of the house now and call 911 from outside. " +
        "Don't try to fix anything. We can't schedule a visit until it's safe, but I'm alerting our on-call team right now.",
    };
  }
  if (flags.includes("water_near_electrical")) {
    return {
      kind: "electrical_water",
      text:
        "Water near electrical is dangerous, so here's the standard safety guidance: stay out of the water and don't touch the panel, outlets, or anything plugged in. " +
        "If you can't reach the main shut-off without stepping into water, leave the area. If anything is sparking, smoking, or someone got shocked, get out and call 911. " +
        "Your electric utility can shut power off safely from outside. I'm alerting our on-call plumber right now so they can call you back as soon as it's safe.",
    };
  }
  if (flags.includes("injury_reported") || flags.includes("person_trapped")) {
    return {
      kind: "medical",
      text: "If anyone is hurt or trapped, please hang up and call 911 right now. I'm alerting our on-call team so someone follows up with you.",
    };
  }
  return {
    kind: "general",
    text:
      "If you feel unsafe, please leave the house and call 911 from outside. We'll never ask you to stay in an unsafe space. I'm alerting our on-call team right now.",
  };
}

export const SHUTOFF_GUIDANCE =
  "While you wait, if you can do it safely: turn the water off at the small valve under or behind the fixture, " +
  "or at your main shut-off — usually where the water line enters the house, in a garage, basement, utility closet, or a box near the street. " +
  "Turn it clockwise until it stops. Don't step into standing water near anything electrical.";

export const WATER_HEATER_SHUTOFF =
  "If the water heater is leaking, you can close the cold-water valve on the pipe at the top of the tank, turning it clockwise.";
