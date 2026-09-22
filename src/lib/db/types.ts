import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "./schema";

/**
 * A Drizzle Postgres database bound to our schema — Neon via node-postgres in
 * production, or PGlite (in-process Postgres) in tests. Both share the same
 * dialect and query API, so pipeline code is written once against `Db`.
 */
export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;
