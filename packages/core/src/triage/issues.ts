/**
 * Plumbing issue classification and fact extraction from caller statements.
 *
 * Issue patterns adapted from HomeGuard Rapid Dispatch's classifier (MIT) and
 * extended with plumbing cases from open-receptionist's emergency_us config
 * (MIT). First match wins, so the order runs most severe to least.
 */
import { normalizeUtterance } from "./safety";
import type { CallFacts, IssueType } from "./types";

const ISSUE_PATTERNS: Array<[IssueType, RegExp]> = [
  ["gas_line_work", /\b(gas line|gas pipe|gas hookup|gas stove hook ?up|run a gas|gas meter)\b(?!.*\bsmell)/],
  ["burst_pipe", /\b((burst|broken|busted|ruptured|split|cracked) (water )?(pipe|line|main)|pipe (burst|broke|busted|ruptured|split|exploded)|water main (broke|burst|break))\b/],
  ["sewage_backup", /\b(sewage|sewer (is )?back(ing|ed)? ?up|sewer line|raw sewage|poop|feces|backing up (into|in) (the )?(tub|shower|basement|floor drain)|(tub|shower|floor drain).{0,30}back(ing|ed)? ?up)\b/],
  ["flooding", /\b(flood(ing|ed)?|water everywhere|standing water|water (is |was )?(pouring|gushing) (in|into|out|everywhere|all over)|inches of water|basement is (full of|under) water)\b/],
  ["sump_pump_failure", /\bsump( pump)?\b/],
  ["frozen_pipe", /\b(frozen|froze) (pipe|pipes|line)|pipes? (are |is )?frozen\b/],
  ["water_heater_leak", /\b(water heater|hot water (tank|heater)|tankless).{0,40}(leak|leaking|dripping|puddle|water on the floor|burst|busted|split|gushing|pouring|spraying)|(leak|leaking|dripping|puddle).{0,40}(water heater|hot water tank)\b/],
  ["no_water", /\b(no water( at all| anywhere| in the (whole )?(house|home))?|water (is )?(completely )?(off|out) (in|for) the (whole )?(house|home)|nothing (comes|coming) out of (any|the) (faucet|tap)s?|(don'?t|do not) have (any )?water)\b/],
  ["no_hot_water", /\b(no hot water|hot water (is )?(out|gone|not working)|water heater (is )?(out|dead|broken|not working|went out|stopped|quit)|(pilot|pilot light) (is )?out|only (getting )?cold water|water (is|stays) cold)\b/],
  // Before active_leak so "faucet is dripping" stays routine.
  ["dripping_faucet", /\b(faucet|tap|spigot|hose bib).{0,30}(drip\w*|leak\w*|won'?t (turn )?off)\b|\b(leaky|leaking|dripping|drippy) (faucet|tap|spigot|hose bib)\b/],
  ["active_leak", /\b(leak(ing|s|y)?|dripping|water (coming|spraying|gushing|running) (out|from|through|down)|ceiling.{0,30}water|water.{0,30}ceiling|spraying)\b/],
  ["toilet_clog", /\btoilet.{0,30}(clog|clogged|blocked|backed up|overflow|won'?t flush|not flushing)|(clog|clogged|blocked|overflowing).{0,20}toilet\b/],
  ["running_toilet", /\btoilet.{0,30}(running|keeps running|won'?t stop|constantly running)\b/],
  ["clogged_drain", /\b(clog|clogged|blocked|slow|backed up|won'?t drain|not draining).{0,30}(drain|sink|tub|shower|bathtub|kitchen)|(drain|sink|tub|shower|bathtub).{0,30}(clog|clogged|blocked|slow|backed up|won'?t drain|not draining)\b/],
  ["garbage_disposal", /\b(garbage )?disposal\b/],
  ["low_water_pressure", /\b(low|weak|no) (water )?pressure\b/],
  ["water_heater_install", /\b(new|replace|replacement|install|installing|upgrade)\b.{0,30}\b(water heater|tankless)\b/],
  ["fixture_install", /\b(install|replace|put in|new)\b.{0,30}\b(faucet|toilet|sink|shower ?head|fixture|dishwasher line|ice maker line|garbage disposal)\b/],
];

/** Trades we decline. Checked against tenant.notOffered as well. */
const NOT_OFFERED_HINTS = /\b(air condition(er|ing)|a\.?c\.? (unit|is|not)|hvac|furnace|heat pump|electrician|electrical work|roof(ing|er)?|appliance repair|washing machine repair|fridge repair|dryer)\b/;

export function classifyIssue(text: string, notOffered: string[] = []): IssueType {
  const t = normalizeUtterance(text);
  if (notOffered.length) {
    for (const trade of notOffered) {
      const term = trade.toLowerCase().trim();
      if (
        term &&
        new RegExp(`\\b${escapeRegExp(term)}\\b`).test(t) &&
        !new RegExp(`\\b(no|not|nowhere near|isn'?t|aren'?t|away from)\\b.{0,20}\\b${escapeRegExp(term)}`).test(t) &&
        !/\b(water|pipe|drain|toilet|sink|leak|sewer|faucet)\b/.test(t)
      ) {
        return term.includes("gas") ? "gas_line_work" : "not_offered";
      }
    }
  }
  for (const [issue, pattern] of ISSUE_PATTERNS) {
    if (pattern.test(t)) return issue;
  }
  if (NOT_OFFERED_HINTS.test(t) && !/\b(no|not|nowhere near|away from)\b.{0,20}\b(electric|electrical)/.test(t) && !/\b(water|pipe|drain|toilet|sink|leak|sewer)\b/.test(t)) return "not_offered";
  return "unknown";
}

const ISSUE_RANK: Record<IssueType, number> = {
  sewage_backup: 10,
  burst_pipe: 10,
  flooding: 9,
  no_water: 9,
  sump_pump_failure: 8,
  frozen_pipe: 7,
  water_heater_leak: 6,
  no_hot_water: 6,
  active_leak: 5,
  toilet_clog: 4,
  clogged_drain: 3,
  running_toilet: 2,
  dripping_faucet: 2,
  garbage_disposal: 2,
  low_water_pressure: 2,
  water_heater_install: 1,
  fixture_install: 1,
  gas_line_work: 1,
  not_offered: 0,
  unknown: -1,
};

/** Keep the more severe of two issues ("leak" then "it burst" => burst_pipe). */
export function escalateIssue(current: IssueType, incoming: IssueType): IssueType {
  if (incoming === "unknown") return current;
  if (current === "unknown") return incoming;
  return ISSUE_RANK[incoming] > ISSUE_RANK[current] ? incoming : current;
}

type FactPatch = Partial<Omit<CallFacts, "issue" | "description" | "safetyFlags">>;

/** Statements that establish facts without a question being asked. */
export function extractStatedFacts(text: string): FactPatch {
  const t = normalizeUtterance(text);
  const patch: FactPatch = {};
  if (/\b(still (leaking|running|spraying|flowing|pouring|coming)|won'?t stop|can'?t stop (it|the water)|water (is )?(pouring|gushing|spraying|flowing|coming in|running everywhere)|actively (leaking|flowing))\b/.test(t)) {
    patch.waterFlowing = true;
  }
  if (/\b((turned|shut|switched) (off )?(the )?(main|water|valve)( off)?|water (is )?(shut |turned )off|stopped (the )?(leak|water)|(it'?s|leak (has|is)) stopped|not (leaking|flowing|running) (any ?more|now)|shut ?off (is )?closed)\b/.test(t)) {
    patch.waterFlowing = false;
    patch.shutoffClosed = true;
    patch.shutoffLocated = true;
  }
  if (/\b(can'?t find (the )?(main|shut ?off|valve)|don'?t know where (the )?(main|shut ?off|valve)|no idea where the (main|shut ?off|valve))\b/.test(t)) {
    patch.shutoffLocated = false;
  } else if (/\b(know where (the )?(main|shut ?off|valve)|found (the )?(main|shut ?off|valve)|(main|shut ?off|valve) is (in|by|under|next to|outside))\b/.test(t)) {
    patch.shutoffLocated = true;
  }
  if (/\b(infant|newborn|baby|babies|toddler|elderly|my (mom|mother|dad|father|grandma|grandmother|grandpa|grandfather) (lives|is staying)|medical (condition|need)|oxygen|dialysis|disabled|wheelchair|chemo|just had surgery|bedridden)\b/.test(t)) {
    patch.vulnerableOccupant = true;
  }
  if (/\b(it'?s an emergency|this is an emergency|emergency|urgent|asap|right now|immediately)\b/.test(t)) {
    patch.callerSaidEmergency = true;
  }
  if (/\b(only (one )?toilet|just (the )?one (toilet|bathroom)|only bathroom)\b/.test(t)) patch.onlyToilet = true;
  if (/\b(coming up (in|through) (the )?(tub|shower|floor drain|basement)|(multiple|several|all the|every) drains?|backing up (into|in) (the )?(tub|shower|basement|house|floor))\b/.test(t)) {
    patch.sewageInHome = true;
  }
  if (/\b(no water (at all|anywhere|in the (whole )?(house|home))|nothing comes out of any|whole (house|home) (has )?no water)\b/.test(t)) {
    patch.wholeHomeNoWater = true;
  }
  if (/\b(nowhere near|not near|away from|no) (any )?(outlets?|electrical|panel|breakers?|wires?)\b/.test(t)) {
    patch.nearElectrical = false;
  }
  return patch;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
