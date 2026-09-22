import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../lib/db/schema";

/**
 * Offline test DB — an in-process Postgres (PGlite) driven through the same
 * Drizzle Postgres dialect used against Neon. No daemon, no network, no Docker.
 * It runs the SAME generated migrations, so a test that passes here proves the
 * schema + queries behave identically under real Postgres.
 *
 * Lives under `src/test-support/` to make clear it is test infrastructure, not
 * production code. `migrationsFolder` is resolved from `import.meta.url` (not
 * the process cwd), so tests pass regardless of the directory they are run from.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function createTestDb(): Promise<{
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => client.close(),
  };
}
