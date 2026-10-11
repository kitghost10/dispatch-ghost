import { loadEnv } from "./config";
import { createContext } from "./context";
import { makeProcessor } from "./jobs";
import { BullQueue, startBullWorker } from "./queue";

/** Background worker: SMS sends (with retries), missed-call text-backs, calendar/FSM sync. */
async function main() {
  const env = loadEnv();
  if (!env.REDIS_URL) throw new Error("worker requires REDIS_URL (without Redis the API runs jobs inline)");
  const ctx = createContext(env);
  ctx.processor = makeProcessor(ctx);
  const worker = startBullWorker(env.REDIS_URL, ctx.processor);
  worker.on("failed", (job, err) => ctx.log.error({ err, job: job?.name, attempts: job?.attemptsMade }, "job failed"));
  if (ctx.queue instanceof BullQueue) await ctx.queue.scheduleSweep();
  ctx.log.info({ store: ctx.store.kind }, "worker started (callback sweep every 60s)");
  const shutdown = async () => {
    await worker.close();
    await ctx.store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
