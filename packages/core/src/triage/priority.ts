/**
 * Deterministic priority engine: facts in, decision out.
 *
 * Mirrors HomeGuard Rapid Dispatch's incident_service/priority.py design (MIT):
 * the LLM extracts facts, this module makes the authoritative decision and
 * records reason codes for audit. Adapted to residential plumbing:
 *
 *   P0  life safety (gas, smoke, fire, CO, sparks, water near electrics,
 *       injury). Evacuate + 911 / gas utility. NEVER booked.
 *   P1  active property damage or loss of an essential service: burst pipe,
 *       uncontrolled leak/flooding, sewage in the home, no water at all.
 *   P2  same day: water heater out, contained leak, only toilet clogged.
 *   P3  routine.
 *
 * The caller's own word ("emergency!") never moves priority — open-receptionist's
 * research notes that self-declared emergencies are overwhelmingly not, and an
 * agent tuned to the word manufactures expensive false dispatches.
 */
import type { CallFacts, FactQuestion, IssueType, Priority, TriageDecision } from "./types";

export interface TriageOptions {
  vulnerableOccupantUpgradesToP1?: boolean;
}

const WATER_ISSUES: ReadonlySet<IssueType> = new Set([
  "burst_pipe",
  "active_leak",
  "flooding",
  "water_heater_leak",
  "frozen_pipe",
  "sump_pump_failure",
  "sewage_backup",
]);

export const QUESTIONS: Record<FactQuestion["key"], string> = {
  nearElectrical:
    "Is any of the water near outlets, the electrical panel, cords or light fixtures?",
  waterFlowing: "Is water still actively leaking or flowing right now?",
  shutoffLocated: "Do you know where your main water shut-off valve is?",
  sewageInHome: "Is sewage or dirty water coming up in more than one drain, or into the living area?",
  vulnerableOccupant:
    "Is there anyone in the home who especially needs it today — like a baby, an elderly person, or someone with a medical need?",
  wholeHomeNoWater: "Is it every faucet in the house with no water, or just one fixture?",
  gasSmellCheck: "Quick safety check — do you smell gas anywhere near the water heater?",
  onlyToilet: "Is that the only toilet in the home?",
};

function q(key: FactQuestion["key"]): FactQuestion {
  return { key, prompt: QUESTIONS[key] };
}

export function openQuestionsFor(facts: CallFacts & { gasSmellChecked?: boolean }): FactQuestion[] {
  const out: FactQuestion[] = [];
  const issue = facts.issue;
  if (WATER_ISSUES.has(issue) || issue === "no_water") {
    if (facts.nearElectrical === undefined && issue !== "no_water") out.push(q("nearElectrical"));
  }
  if (["active_leak", "burst_pipe", "flooding", "water_heater_leak", "frozen_pipe"].includes(issue)) {
    if (facts.waterFlowing === undefined && facts.shutoffClosed !== true) out.push(q("waterFlowing"));
    if (facts.waterFlowing !== false && facts.shutoffLocated === undefined && facts.shutoffClosed !== true) out.push(q("shutoffLocated"));
  }
  if (issue === "sewage_backup" && facts.sewageInHome === undefined) out.push(q("sewageInHome"));
  if (issue === "no_water" && facts.wholeHomeNoWater === undefined) out.push(q("wholeHomeNoWater"));
  if ((issue === "no_hot_water" || issue === "water_heater_leak") && !facts.gasSmellChecked) out.push(q("gasSmellCheck"));
  if ((issue === "no_hot_water" || issue === "no_water") && facts.vulnerableOccupant === undefined) out.push(q("vulnerableOccupant"));
  if (issue === "toilet_clog" && facts.onlyToilet === undefined) out.push(q("onlyToilet"));
  return out;
}

export function determinePriority(
  facts: CallFacts & { gasSmellChecked?: boolean },
  options: TriageOptions = {},
): TriageDecision {
  const reasonCodes: string[] = [];
  const openQuestions = openQuestionsFor(facts);
  if (facts.callerSaidEmergency) reasonCodes.push("NOTE:CALLER_SAID_EMERGENCY_NOT_USED_FOR_PRIORITY");

  // A caller who is merely unsure is only P0 when the context involves a hazard
  // class; on its own we still treat it as P0 (HomeGuard policy: when in doubt
  // about fire/gas/CO/electrics, escalate).
  if (facts.safetyFlags.length > 0) {
    return {
      priority: "P0",
      issue: facts.issue,
      reasonCodes: [...facts.safetyFlags.map((f) => `SAFETY_FLAG:${f.toUpperCase()}`), ...reasonCodes],
      safetyTriggers: [...facts.safetyFlags],
      schedulable: false,
      requiresLiveHuman: true,
      sameDay: false,
      openQuestions: [],
    };
  }

  let priority: Priority = "P3";
  const issue = facts.issue;
  const uncontrolled = facts.waterFlowing === true && facts.shutoffClosed !== true;

  switch (issue) {
    case "burst_pipe":
      priority = "P1";
      reasonCodes.push("ISSUE:BURST_PIPE");
      break;
    case "flooding":
      if (facts.waterFlowing === false || facts.shutoffClosed) {
        priority = "P2";
        reasonCodes.push("ISSUE:FLOODING", "CONTEXT:SOURCE_STOPPED");
      } else {
        priority = "P1";
        reasonCodes.push("ISSUE:FLOODING");
      }
      break;
    case "sump_pump_failure":
      priority = uncontrolled || facts.waterFlowing === undefined ? "P1" : "P2";
      reasonCodes.push("ISSUE:SUMP_PUMP");
      break;
    case "sewage_backup":
      if (facts.sewageInHome === false) {
        priority = "P2";
        reasonCodes.push("ISSUE:SEWER_SLOW", "CONTEXT:NOT_IN_LIVING_AREA");
      } else {
        priority = "P1";
        reasonCodes.push("ISSUE:SEWAGE_BACKUP");
      }
      break;
    case "no_water":
      if (facts.wholeHomeNoWater === false) {
        priority = "P3";
        reasonCodes.push("ISSUE:SINGLE_FIXTURE_NO_WATER");
      } else {
        priority = "P1";
        reasonCodes.push("ISSUE:NO_WATER");
      }
      break;
    case "active_leak":
    case "water_heater_leak":
    case "frozen_pipe":
      if (uncontrolled && facts.shutoffLocated === false) {
        priority = "P1";
        reasonCodes.push(`ISSUE:${issue.toUpperCase()}`, "CONTEXT:UNCONTROLLED_NO_SHUTOFF");
      } else if (uncontrolled) {
        // Flowing now; drops to P2 once the caller confirms the shut-off is closed.
        priority = "P1";
        reasonCodes.push(`ISSUE:${issue.toUpperCase()}`, "CONTEXT:ACTIVE_FLOW_SHUTOFF_PENDING");
      } else {
        priority = "P2";
        reasonCodes.push(`ISSUE:${issue.toUpperCase()}`, facts.waterFlowing === false ? "CONTEXT:CONTAINED" : "CONTEXT:FLOW_UNKNOWN");
      }
      break;
    case "no_hot_water":
      priority = "P2";
      reasonCodes.push("ISSUE:NO_HOT_WATER");
      break;
    case "toilet_clog":
      priority = facts.onlyToilet ? "P2" : "P3";
      reasonCodes.push("ISSUE:TOILET_CLOG", ...(facts.onlyToilet ? ["CONTEXT:ONLY_TOILET"] : []));
      break;
    default:
      priority = "P3";
      reasonCodes.push(`ISSUE:${issue.toUpperCase()}`, "DEFAULT:ROUTINE");
  }

  if (facts.vulnerableOccupant && (issue === "no_hot_water" || issue === "no_water" || priority === "P2")) {
    reasonCodes.push("CONTEXT:VULNERABLE_OCCUPANT");
    if (options.vulnerableOccupantUpgradesToP1 && priority === "P2") {
      priority = "P1";
      reasonCodes.push("UPGRADE:VULNERABLE_OCCUPANT");
    }
  }

  return {
    priority,
    issue,
    reasonCodes,
    safetyTriggers: [],
    schedulable: issue !== "not_offered" && issue !== "gas_line_work",
    requiresLiveHuman: priority === "P1",
    sameDay: priority === "P2" || priority === "P1",
    openQuestions,
  };
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function morePressing(a: Priority, b: Priority): Priority {
  return RANK[a] <= RANK[b] ? a : b;
}
export function priorityRank(p: Priority): number {
  return RANK[p];
}
