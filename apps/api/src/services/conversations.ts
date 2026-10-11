import { ReceptionistSession, ScriptedReceptionist, findUnapprovedPrices, noQuoteStatement, type AgentTurn, type SessionState } from "@sb/core";
import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";
import { makeEffects } from "./effects";
import { makeScheduler } from "./scheduler";
import { llmSmsRespond } from "./llmSms";

export function newSession(ctx: AppContext, tenant: Tenant, callId: string, input: { channel: "voice" | "sms"; callerPhone: string } | { state: SessionState }, opts: { simulated?: boolean } = {}) {
  const effects = makeEffects(ctx, tenant, callId, opts);
  const session = new ReceptionistSession(
    {
      config: tenant.config,
      scheduler: makeScheduler(ctx, tenant, callId),
      effects,
      now: ctx.now,
      ...(ctx.geocoder ? { geocoder: ctx.geocoder } : {}),
    },
    input,
  );
  return { session, effects };
}

/**
 * Produce the next reply for a text channel (SMS or dashboard simulator).
 * LLM when configured, scripted otherwise; an unapproved price in the LLM's
 * reply is blocked and replaced by the scripted answer.
 */
export async function textTurn(ctx: AppContext, session: ReceptionistSession, text: string, history: Array<{ role: "caller" | "agent" | "system"; text: string }>, opts: { allowLlm: boolean }): Promise<AgentTurn & { engine: "llm" | "scripted" }> {
  const scripted = new ScriptedReceptionist(session);
  const sms = session.config.sms;
  const provider = sms.provider === "agency" ? (ctx.env.OPENAI_API_KEY ? "openai" : "openrouter") : sms.provider;
  const apiKey = provider === "openrouter" ? ctx.env.OPENROUTER_API_KEY : ctx.env.OPENAI_API_KEY;
  const model = sms.model ?? (provider === "openrouter" ? ctx.env.OPENROUTER_SMS_MODEL ?? ctx.env.OPENROUTER_MODEL : ctx.env.OPENAI_SMS_MODEL);
  if (opts.allowLlm && ctx.env.APP_MODE === "live" && apiKey && sms.aiReplies) {
    const snapshot = structuredClone(session.state);
    try {
      const turn = await llmSmsRespond(session, text, { apiKey, model, provider, history });
      if (turn.say && findUnapprovedPrices(turn.say, session.config).length === 0) return { ...turn, engine: "llm" };
      ctx.log.warn({ reply: turn.say }, "LLM SMS reply blocked by price guard or empty");
      // Tools can already have created bookings or callbacks; never roll them back in memory.
      return { ...turn, say: noQuoteStatement(session.config), engine: "llm" };
    } catch (err) {
      ctx.log.warn({ err }, "LLM SMS responder failed; using scripted reply");
    }
    if (session.state.booking && !snapshot.booking) return { say: `Your appointment is booked ${session.state.booking.slot.spoken}. Please contact the office if you need help.`, actions: [], engine: "llm" };
    if (session.state.callbackCreated && !snapshot.callbackCreated) return { say: "Your message has been sent to the team for a callback.", actions: [], engine: "llm" };
    // Preserve completed tool effects when falling back after a provider error.
  }
  return { ...(await scripted.respond(text)), engine: "scripted" };
}
