import { seedDemo } from "@sb/db";
import { loadEnv } from "./config";
import { createContext } from "./context";
import { seedDemoActivity } from "./demoActivity";
import { buildServer } from "./server";
import { InlineQueue } from "./queue";
import { sweepOverdueCallbacks } from "./jobs";

async function main() {
  const env = loadEnv();
  const ctx = createContext(env);
  let seeded = false;
  if (env.APP_MODE === "mock" && env.SEED_DEMO) {
    const { tenant } = await seedDemo(ctx.store, { adminPassword: env.SEED_ADMIN_PASSWORD });
    seeded = (await ctx.store.listCalls(tenant.id, { limit: 1 })).length === 0;
  }
  const app = await buildServer(ctx);
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ mode: env.APP_MODE, store: ctx.store.kind, voice: ctx.voice.name, telephony: ctx.telephony.kind }, "Sonic Bold receptionist API ready");
  if (seeded) {
    try {
      await seedDemoActivity(ctx, `http://127.0.0.1:${env.PORT}`);
      app.log.info("seeded demo calls (login admin@sonicbold.test / SEED_ADMIN_PASSWORD)");
    } catch (err) {
      app.log.warn({ err }, "demo activity seeding failed");
    }
  }
  // Without Redis there is no worker process: sweep overdue urgent callbacks here.
  const sweep = ctx.queue instanceof InlineQueue ? setInterval(() => void sweepOverdueCallbacks(ctx).catch((err) => app.log.error({ err }, "callback sweep failed")), 60_000) : null;
  const shutdown = async () => {
    if (sweep) clearInterval(sweep);
    await app.close();
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
