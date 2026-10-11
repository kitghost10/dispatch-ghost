/**
 * Deterministic hazard detection.
 *
 * Ported (TypeScript rewrite) from HomeGuard Rapid Dispatch
 * services/incident-service/incident_service/classifier.py (MIT, see
 * THIRD_PARTY_NOTICES.md), narrowed and extended for residential plumbing.
 *
 * The LLM may also report flags through the `record_facts` tool, but this scan
 * runs on EVERY caller utterance in code, so a hazard is caught even if the
 * model misses it. Flags only ratchet upward: nothing clears a hazard mid-call.
 */
import type { SafetyFlag } from "./types";

const SAFETY_PATTERNS: Array<[SafetyFlag, RegExp]> = [
  ["visible_fire", /\b(fire|flames?|on fire|caught fire)\b/],
  ["smoke_present", /\b(smoke|smoking|smoky)\b/],
  [
    "gas_odor",
    /\b(smell(s|ing|ed)?( of| like)? (natural )?gas|gas (smell|odou?r|leak)|rotten eggs?|sulfur smell|smells? like sulfur|hissing (sound )?(from|near|at) the (gas|meter|line))\b/,
  ],
  ["carbon_monoxide_alarm", /\b(carbon monoxide|co (alarm|detector)|co2? alarm)\b/],
  ["active_sparks", /\bspark(s|ing|ed)?\b/],
  ["burning_smell", /\b(burning (smell|odou?r|plastic)|smells? like (something('s)? )?burning)\b/],
  [
    "water_near_electrical",
    /\b(water|leak(ing)?|flood(ing|ed)?|dripping|puddle|wet).{0,60}\b(outlets?|electrical|electric(al)? panel|panel|breakers?|breaker box|fuse box|wires?|wiring|light fixtures?|extension cords?|power strips?)\b|\b(outlets?|electrical|panel|breakers?|breaker box|fuse box|wires?|wiring|light fixtures?)\b.{0,60}\b(water|wet|leak(ing)?|flood(ing|ed)?|dripping|soaked)\b/,
  ],
  [
    "injury_reported",
    /\b(hurt|injur(y|ed|ies)|bleeding|unconscious|passed out|burn(ed|t) (myself|my|his|her|their)|scald(ed)?|shock(ed)? (me|him|her|them)|got shocked|electrocuted|fell (through|down)|slipped and fell)\b/,
  ],
  ["person_trapped", /\b(trapped|stuck in|can'?t get out)\b/],
];

const UNSURE_SAFE_RE =
  /\b(not sure (if|whether) (it|we|i)('s| am| are| is)? safe|might not be safe|don'?t (know|feel) (if )?(i'?m|we'?re|it'?s)? ?safe|feel(s)? unsafe|not safe)\b/;

/**
 * Handles enumerated denials like "no fire or smoke or sparks" and
 * "I don't smell gas". Looks back up to 60 characters for a negator followed
 * by at most six filler words.
 */
function isNegated(text: string, matchStart: number): boolean {
  const window = text.slice(Math.max(0, matchStart - 60), matchStart);
  return /\b(no|not|nothing|none|neither|nor|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|without|never|any)\s+([\w']+[\s,]+){0,6}$/.test(
    window,
  );
}

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'$.,?!\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSafetyFlags(text: string): SafetyFlag[] {
  const lowered = normalizeUtterance(text);
  const flags = new Set<SafetyFlag>();
  for (const [flag, pattern] of SAFETY_PATTERNS) {
    const global = new RegExp(pattern.source, "g");
    for (const match of lowered.matchAll(global)) {
      const inner = flag === "water_near_electrical" && /\b(not|nowhere|away from|far from|no|isn'?t|aren'?t)\b/.test(match[0]);
      if (!inner && !isNegated(lowered, match.index ?? 0)) {
        flags.add(flag);
        break;
      }
    }
  }
  // "Fire" in plumbing talk is usually "fire sprinkler" or "fireplace"; don't
  // evacuate a caller asking about a sprinkler line or fireplace gas key.
  if (flags.has("visible_fire") && /\b(fire ?sprinkler|fireplace|fire hydrant|fire line)\b/.test(lowered)) {
    const stripped = lowered.replace(/\b(fire ?sprinkler|fireplace|fire hydrant|fire line)\b/g, "");
    if (!/\b(fire|flames?|on fire|caught fire)\b/.test(stripped)) flags.delete("visible_fire");
  }
  // "Smoke test" is a plumbing diagnostic, not a hazard.
  if (flags.has("smoke_present") && /\bsmoke test/.test(lowered) && !/\bsmoke (coming|from|in)\b/.test(lowered)) {
    flags.delete("smoke_present");
  }
  if (UNSURE_SAFE_RE.test(lowered)) {
    const match = UNSURE_SAFE_RE.exec(lowered);
    if (match && !isNegated(lowered, match.index)) flags.add("caller_unsure_if_safe");
  }
  return [...flags];
}

export function mergeFlags(existing: SafetyFlag[], incoming: SafetyFlag[]): SafetyFlag[] {
  return [...new Set([...existing, ...incoming])];
}
