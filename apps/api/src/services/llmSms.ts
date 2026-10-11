/**
 * Optional LLM responder for inbound SMS (live mode with OPENAI_API_KEY).
 * Uses Chat Completions function calling with the SAME receptionist tools,
 * so every rule is still enforced by ReceptionistSession. Any failure falls
 * back to the scripted receptionist.
 */
import { buildInstructions, executeTool, localNow, RECEPTIONIST_TOOLS, type AgentTurn, type ReceptionistSession, type RuntimeAction } from "@sb/core";

export interface LlmSmsOptions {
  apiKey: string;
  model: string;
  history: Array<{ role: "caller" | "agent" | "system"; text: string }>;
  fetchImpl?: typeof fetch;
  provider?: "openai" | "openrouter";
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export async function llmSmsRespond(session: ReceptionistSession, text: string, opts: LlmSmsOptions): Promise<AgentTurn> {
  const f = opts.fetchImpl ?? fetch;
  session.observeCaller(text);
  if (session.isLockedForSafety) return session.handleLifeSafety();
  const config = session.config;
  const messages: ChatMessage[] = [
    { role: "system", content: buildInstructions(config, { channel: "sms", afterHours: session.state.afterHours, localTimeLabel: localNow(config, session.now()).toFormat("cccc h:mm a") }) },
    ...opts.history.filter((h) => h.role !== "system").slice(-12).map((h): ChatMessage => (h.role === "caller" ? { role: "user", content: h.text } : { role: "assistant", content: h.text })),
    { role: "user", content: text },
  ];
  const tools = RECEPTIONIST_TOOLS.filter((t) => t.name !== "transfer_call" && t.name !== "end_call").map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const actions: RuntimeAction[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await f(opts.provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, tools, temperature: 0.3 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`OpenAI chat ${res.status}`);
    const json = (await res.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } }> };
    const msg = json.choices[0]?.message;
    if (!msg) throw new Error("OpenAI chat: empty response");
    if (!msg.tool_calls?.length) {
      if (session.isLockedForSafety) return session.handleLifeSafety();
      return { say: (msg.content ?? "").trim(), actions };
    }
    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const out = await executeTool(session, call.function.name, args);
      if (out.action) actions.push(out.action);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.output) });
      if (out.output.lifeSafety === true || out.output.error === "life_safety_lockout") {
        return { say: String(out.output.mustSay ?? ""), actions };
      }
    }
  }
  throw new Error("OpenAI chat: too many tool rounds");
}
