import { dialTwiml, sayHangupTwiml } from "@sb/providers";
import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";
import { sign } from "../auth";

export function signedQuery(ctx: AppContext, tenantId: string, callId: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ tenantId, callId, ...extra, sig: sign(ctx.env.SESSION_SECRET, `${tenantId}:${callId}`) });
  return q.toString();
}

export function transferDialTwiml(ctx: AppContext, tenant: Tenant, input: { callId: string; callerE164: string; numbers: string[]; index: number; sayFirst?: string }): string {
  const number = input.numbers[input.index];
  if (!number) return sayHangupTwiml();
  return dialTwiml({
    number,
    callerId: input.callerE164,
    timeoutSec: tenant.config.transfer.dialTimeoutSec,
    action: `${ctx.env.PUBLIC_BASE_URL}/twilio/voice/transfer-result?${signedQuery(ctx, tenant.id, input.callId, { i: String(input.index) })}`,
    whisperUrl: `${ctx.env.PUBLIC_BASE_URL}/twilio/voice/whisper?${signedQuery(ctx, tenant.id, input.callId)}`,
    ...(input.sayFirst ? { sayFirst: input.sayFirst } : {}),
    record: tenant.config.recording.enabled,
  });
}
