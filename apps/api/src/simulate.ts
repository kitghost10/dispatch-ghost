/**
 * Interactive phone-call simulator (no Twilio/OpenAI):
 *   pnpm --filter @sb/api simulate            # in-process API, demo tenant
 *   pnpm --filter @sb/api simulate --at 2026-09-30T04:30:00Z   # pretend it's after hours
 * Type what the caller says; "/hangup" ends, "/fail" fails a pending transfer.
 */
import readline from "node:readline/promises";
import { MemoryStore, seedDemo, DEMO_BUSINESS_NUMBER } from "@sb/db";
import { MockTelephony } from "@sb/providers";
import { loadEnv } from "./config";
import { createContext } from "./context";
import { buildServer } from "./server";
import { CallDriver, parseDial, parseSay } from "./dev/callDriver";

async function main() {
  const atIdx = process.argv.indexOf("--at");
  const at = atIdx > 0 ? new Date(process.argv[atIdx + 1]!) : null;
  const env = loadEnv({ ...process.env, APP_MODE: "mock", LOG_LEVEL: "warn" });
  const telephony = new MockTelephony();
  const ctx = createContext(env, { store: new MemoryStore(), telephony, ...(at ? { now: () => at } : {}) });
  await seedDemo(ctx.store, { adminPassword: "x" });
  const app = await buildServer(ctx, { logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  ctx.env.PUBLIC_BASE_URL = base;
  const d = new CallDriver({ baseUrl: base, from: "+15125550142", to: DEMO_BUSINESS_NUMBER });
  if (d.preamble) console.info(`[preamble] ${d.preamble}`);
  console.info(`AGENT: ${await d.start()}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("YOU: ")).trim();
    if (line === "/hangup" || line === "") break;
    const reply = await d.say(line);
    if (reply) console.info(`AGENT: ${reply}`);
    const update = telephony.liveCallUpdates.at(-1);
    if (update && update.callSid === d.callSid) {
      const dial = parseDial(update.twiml);
      if (dial) {
        const ans = (await rl.question(`[transfer → ${dial.number}] answered? (y/n): `)).trim();
        await d.stopStream();
        let next = await d.dialResult(dial.action, ans === "y" ? "completed" : "no-answer");
        let nd = parseDial(next);
        while (nd && ans !== "y") {
          const a2 = (await rl.question(`[transfer → ${nd.number}] answered? (y/n): `)).trim();
          next = await d.dialResult(nd.action, a2 === "y" ? "completed" : "no-answer");
          if (a2 === "y") break;
          nd = parseDial(next);
        }
        for (const s of parseSay(next)) console.info(`AGENT: ${s}`);
      } else {
        console.info("[call ended by agent]");
      }
      break;
    }
  }
  rl.close();
  await d.end();
  await new Promise((r) => setTimeout(r, 100));
  console.info("\nSMS outbox:");
  for (const m of telephony.sms) console.info(`  → ${m.to}: ${m.body}`);
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
