import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let db: NodePgDatabase<typeof schema> | undefined;

/**
 * Production DB client — Neon Postgres via node-postgres.
 *
 * Why `pg.Pool` and not `@neondatabase/serverless` (which the design named):
 * the pipeline code is written against a plain `pg` client that PGlite also
 * satisfies in tests, keeping one dialect for both. `@neondatabase/serverless`
 * re-exports a `pg`-compatible API, so it is a drop-in later if we move to
 * edge/serverless runtimes. CAVEAT: `pg.Pool` holds a fixed pool of TCP
 * connections — on a serverless platform (e.g. Vercel/Cloudflare) where each
 * invocation is a short-lived isolate, a long-lived pool can exhaust the
 * database's connection limit. If this app deploys to a serverless target,
 * switch to `@neondatabase/serverless` (per-invocation connections over
 * WebSocket) and do NOT reuse the pool across cold starts.
 *
 * Lazily created so importing this module never opens a connection at
 * build/typecheck time.
 */
export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set — cannot connect to Neon");
    }
    db = drizzle(new Pool({ connectionString: url }), { schema });
  }
  return db;
}
