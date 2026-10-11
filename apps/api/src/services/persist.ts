import type { ReceptionistSession } from "@sb/core";
import type { AppContext } from "../context";

/** Mirror session state onto the call row (dashboard columns + rehydration). */
export async function persistSession(ctx: AppContext, tenantId: string, callId: string, session: ReceptionistSession, extra: Record<string, unknown> = {}) {
  const s = session.state;
  const known = s.facts.issue !== "unknown" || s.facts.safetyFlags.length > 0;
  await ctx.store.updateCall(tenantId, callId, {
    priority: known ? s.peakPriority : null,
    issue: s.facts.issue,
    outcome: s.outcome,
    safetyFlags: s.facts.safetyFlags,
    reasonCodes: s.triage.reasonCodes,
    summary: session.summary(),
    transferStatus: s.transfer?.status ?? null,
    state: s,
    ...extra,
  });
}
