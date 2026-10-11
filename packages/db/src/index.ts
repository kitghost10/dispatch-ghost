export * from "./types";
export * from "./memoryStore";
export * from "./pgStore";
export * from "./migrate";
export * from "./seed";
export * from "./password";

import { MemoryStore } from "./memoryStore";
import { PgStore } from "./pgStore";
import type { Store } from "./types";

/** DATABASE_URL set => Postgres (connect as sb_app); otherwise in-memory (mock/dev). */
export function createStore(databaseUrl?: string): Store {
  return databaseUrl ? new PgStore(databaseUrl) : new MemoryStore();
}
