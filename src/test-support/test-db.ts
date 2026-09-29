import { createPgliteDb } from "../lib/db/pglite";

/**
 * Offline test DB — an in-process Postgres (PGlite) driven through the same
 * Drizzle Postgres dialect used against Neon. No daemon, no network, no Docker.
 * It runs the SAME generated migrations, so a test that passes here proves the
 * schema + queries behave identically under real Postgres.
 *
 * The PGlite boot + migration logic lives in `src/lib/db/pglite.ts` so the demo
 * composition reuses the exact same path instead of duplicating it. This module
 * remains the test-facing alias for ergonomic `createTestDb` call sites.
 */
export const createTestDb = createPgliteDb;
