import { migrate } from "./migrate";
import { PgStore } from "./pgStore";
import { seedDemo } from "./seed";

async function main() {
  const cmd = process.argv[2];
  if (cmd === "migrate") {
    const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_OWNER_URL;
    if (!url) throw new Error("Set MIGRATION_DATABASE_URL (owner role) to run migrations");
    const applied = await migrate(url, { ...(process.env.SB_APP_DB_PASSWORD ? { appRolePassword: process.env.SB_APP_DB_PASSWORD } : {}), log: (m) => console.info(m) });
    console.info(applied.length ? `migrations applied: ${applied.length}` : "database up to date");
    return;
  }
  if (cmd === "seed") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Set DATABASE_URL (sb_app role) to seed");
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!password) throw new Error("Set SEED_ADMIN_PASSWORD");
    const store = new PgStore(url, 2);
    try {
      const r = await seedDemo(store, { adminPassword: password });
      console.info(`seeded tenant ${r.tenant.slug} (${r.tenant.id}); admin ${r.admin.email}; owner ${r.owner.email}`);
    } finally {
      await store.close();
    }
    return;
  }
  throw new Error("usage: cli.ts migrate|seed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
