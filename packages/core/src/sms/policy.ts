/**
 * SMS compliance: STOP/HELP/START keywords and consent state.
 *
 * Keyword sets follow LobbyStack packages/domain/src/server/sms.ts (MIT) and
 * CTIA / Twilio Advanced Opt-Out defaults. Twilio also enforces STOP at the
 * carrier edge; we still record it so the app never queues a message to an
 * opted-out number (Twilio would reject it with error 21610 anyway).
 */
import type { TenantConfig } from "../tenant/config";

export const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL", "REVOKE", "OPTOUT"]);
export const SMS_START_KEYWORDS = new Set(["START", "UNSTOP", "SUBSCRIBE"]);
export const SMS_HELP_KEYWORDS = new Set(["HELP", "INFO"]);

export type ConsentStatus = "unknown" | "implied" | "granted" | "opted_out";

export function normalizeSmsKeyword(value: string): string {
  return value.trim().replace(/[^a-zA-Z]/g, "").toUpperCase();
}

export type KeywordClass = { kind: "stop" | "start" | "help" } | null;

export function classifyKeyword(body: string, optOutType?: string): KeywordClass {
  const fromTwilio = optOutType ? normalizeSmsKeyword(optOutType) : "";
  if (fromTwilio === "STOP") return { kind: "stop" };
  if (fromTwilio === "START") return { kind: "start" };
  if (fromTwilio === "HELP") return { kind: "help" };
  const word = normalizeSmsKeyword(body);
  // Only a message that is JUST the keyword counts ("stop" yes, "don't stop by" no).
  if (body.trim().split(/\s+/).length > 2) return null;
  if (SMS_STOP_KEYWORDS.has(word)) return { kind: "stop" };
  if (SMS_HELP_KEYWORDS.has(word)) return { kind: "help" };
  if (SMS_START_KEYWORDS.has(word)) return { kind: "start" };
  return null;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
}

export function helpReply(config: TenantConfig, businessPhone: string): string {
  return renderTemplate(config.sms.helpText, { company: config.brand.companyName, phone: businessPhone });
}

export function stopReply(config: TenantConfig): string {
  return `${config.brand.companyName}: You're unsubscribed and won't receive more texts. Reply START to resubscribe.`;
}

export function startReply(config: TenantConfig): string {
  return `${config.brand.companyName}: You're subscribed again. Msg&data rates may apply. Reply HELP for help, STOP to opt out.`;
}

export function missedCallText(config: TenantConfig): string {
  return renderTemplate(config.sms.missedCallTemplate, { company: config.brand.companyName });
}

/**
 * May we send a (non-keyword-reply) message to this number?
 *  - opted_out: never.
 *  - A caller who phoned us has an established business relationship for a
 *    one-off transactional reply (missed-call text-back). Anything recurring
 *    or promotional needs explicit consent. Tenants should confirm with
 *    counsel; see docs/a2p-10dlc.md.
 */
export function maySend(status: ConsentStatus, purpose: "keyword_reply" | "transactional" | "conversation_reply" | "marketing"): boolean {
  if (purpose === "keyword_reply") return true;
  if (status === "opted_out") return false;
  if (purpose === "marketing") return status === "granted";
  return true;
}
