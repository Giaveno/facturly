import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

/**
 * Offline in-process Postgres (PGlite) — the `DATABASE_DRIVER=pglite` backend
 * behind the demo and the offline test suite. It runs the SAME generated
 * `drizzle/` migrations as Neon, so a query that passes here behaves identically
 * under real Postgres. No daemon, no network, no Docker.
 *
 * This module is the SINGLE owner of the PGlite boot + migration path, shared by
 * the demo composition (`src/lib/composition.ts`) and the test harness
 * (`src/test-support/test-db.ts`) so the migration folder is resolved in exactly
 * one place. `migrationsFolder` is resolved from `import.meta.url` (not the
 * process cwd), so it works regardless of the directory a caller runs from.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** A live PGlite handle — the database plus a `close` for teardown. */
export interface PgliteDbHandle {
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

/** Boots a fresh in-process Postgres and applies the full migration set. */
export async function createPgliteDb(): Promise<PgliteDbHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => client.close(),
  };
}
