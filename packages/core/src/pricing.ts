/**
 * Pricing policy. The trip/diagnostic fee is the ONE number the receptionist
 * states on its own; repair prices are never quoted (open-receptionist
 * emergency_us: "quoting a repair over the phone would be a guess"). Optional
 * "starting at" prices are tenant opt-in and always framed as a floor.
 */
import type { ServiceConfig, TenantConfig } from "./tenant/config";
import { normalizeUtterance } from "./triage/safety";

export function spokenDollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

export function tripFeeFor(config: TenantConfig, afterHours: boolean): number {
  return afterHours && config.pricing.afterHoursTripFee !== undefined ? config.pricing.afterHoursTripFee : config.pricing.tripFee;
}

export function tripFeeStatement(config: TenantConfig, afterHours: boolean): string {
  const fee = spokenDollars(tripFeeFor(config, afterHours));
  const credited = config.pricing.creditedTowardRepair ? ", and it's credited toward the repair if you go ahead with the work" : "";
  const when = afterHours && config.pricing.afterHoursTripFee !== undefined ? " after hours" : "";
  return `Just so you know up front, our ${config.pricing.tripFeeLabel}${when} is ${fee}. That covers the plumber coming out and diagnosing the problem${credited}. The plumber gives you the exact repair price on site before any work starts.`;
}

export function noQuoteStatement(config: TenantConfig, service?: ServiceConfig, pushedAgain = false): string {
  const fee = spokenDollars(config.pricing.tripFee);
  const startingAt =
    config.pricing.allowStartingAtPrices && service?.startingAtPrice !== undefined
      ? ` For ${service.label.toLowerCase()}, jobs start at ${spokenDollars(service.startingAtPrice)}, but the final price depends on what the plumber finds.`
      : "";
  if (pushedAgain) {
    return `I understand wanting a number. Honestly, any repair price over the phone would be a guess, and we don't guess with your money. The ${config.pricing.tripFeeLabel} is ${fee}, and the plumber quotes the exact price on site before doing anything.${startingAt} Would you like me to get someone out?`;
  }
  return `I can't quote the repair itself over the phone, because it depends on what the plumber finds. What I can tell you is the ${config.pricing.tripFeeLabel} is ${fee}, and you get an upfront price on site before any work starts.${startingAt}`;
}

const PRICE_Q =
  /\b(how much|what('?s| is| do you) (the )?(cost|charge|price)|what do you charge|price|pricing|quote|estimate|ballpark|rough (idea|number)|cost to|costs?|rates?|fee|expensive|cheap)\b/;

export function isPriceQuestion(text: string): boolean {
  return PRICE_Q.test(normalizeUtterance(text));
}

/**
 * Output guard: flags assistant utterances that mention a dollar amount other
 * than the configured trip fee / starting-at prices. Used on realtime
 * transcripts to record violations and on SMS replies to block them.
 */
export function findUnapprovedPrices(text: string, config: TenantConfig): number[] {
  const approved = new Set<number>([config.pricing.tripFee]);
  if (config.pricing.afterHoursTripFee !== undefined) approved.add(config.pricing.afterHoursTripFee);
  if (config.pricing.allowStartingAtPrices) {
    for (const s of config.services) if (s.startingAtPrice !== undefined) approved.add(s.startingAtPrice);
  }
  const found: number[] = [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)|\b(\d{2,5}) dollars\b/gi;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
    const value = Number(raw);
    if (Number.isFinite(value) && !approved.has(value)) found.push(value);
  }
  return found;
}
