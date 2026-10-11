export const SAFETY_FLAGS = [
  "gas_odor",
  "carbon_monoxide_alarm",
  "visible_fire",
  "smoke_present",
  "active_sparks",
  "burning_smell",
  "water_near_electrical",
  "injury_reported",
  "person_trapped",
  "caller_unsure_if_safe",
] as const;
export type SafetyFlag = (typeof SAFETY_FLAGS)[number];

export const ISSUE_TYPES = [
  "burst_pipe",
  "active_leak",
  "flooding",
  "sewage_backup",
  "no_water",
  "water_heater_leak",
  "no_hot_water",
  "frozen_pipe",
  "sump_pump_failure",
  "clogged_drain",
  "toilet_clog",
  "running_toilet",
  "dripping_faucet",
  "garbage_disposal",
  "low_water_pressure",
  "fixture_install",
  "water_heater_install",
  "gas_line_work",
  "not_offered",
  "unknown",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export type Priority = "P0" | "P1" | "P2" | "P3";

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: "Life safety",
  P1: "Emergency",
  P2: "Same day",
  P3: "Routine",
};

/** Target response times used for callbacks and dashboard SLAs. */
export const PRIORITY_SLA_MINUTES: Record<Priority, number> = {
  P0: 5,
  P1: 60,
  P2: 8 * 60,
  P3: 72 * 60,
};

/**
 * Facts the receptionist has established. Every field is tri-state
 * (undefined = not asked / unknown) because "false" is an answer, not a gap.
 */
export interface CallFacts {
  issue: IssueType;
  /** The caller's own words, accumulated. */
  description: string[];
  safetyFlags: SafetyFlag[];
  waterFlowing?: boolean;
  nearElectrical?: boolean;
  shutoffLocated?: boolean;
  shutoffClosed?: boolean;
  /** Sewage coming up in more than one drain or into living space. */
  sewageInHome?: boolean;
  /** Only toilet in the home is unusable. */
  onlyToilet?: boolean;
  wholeHomeNoWater?: boolean;
  vulnerableOccupant?: boolean;
  /** Recorded for analytics only. Never used to set priority. */
  callerSaidEmergency?: boolean;
}

export interface TriageDecision {
  priority: Priority;
  issue: IssueType;
  reasonCodes: string[];
  safetyTriggers: SafetyFlag[];
  /** May a visit be booked? Never for P0. */
  schedulable: boolean;
  /** Needs a human now (on-call or office). */
  requiresLiveHuman: boolean;
  /** P2: must be offered today's slots first. */
  sameDay: boolean;
  /** Fact questions still worth asking, most important first. */
  openQuestions: FactQuestion[];
}

export type FactQuestionKey =
  | "waterFlowing"
  | "nearElectrical"
  | "shutoffLocated"
  | "sewageInHome"
  | "vulnerableOccupant"
  | "wholeHomeNoWater"
  | "gasSmellCheck"
  | "onlyToilet";

export interface FactQuestion {
  key: FactQuestionKey;
  prompt: string;
}
