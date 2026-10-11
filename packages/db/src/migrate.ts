import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Apply SQL migrations in order as the owner role. Each file runs in its own
 * transaction and is recorded in schema_migrations.
 */
export async function migrate(ownerUrl: string, opts: { appRolePassword?: string; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => String(r.name)));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (opts.appRolePassword) {
      // Dev/compose convenience: let the runtime role log in. In production, manage this in your secret store.
      await client.query(`ALTER ROLE sb_app LOGIN PASSWORD ${pg.escapeLiteral(opts.appRolePassword)}`);
      log("sb_app login enabled");
    }
  } finally {
    await client.end();
  }
  return applied;
}
