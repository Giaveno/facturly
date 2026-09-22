import { defineConfig } from "drizzle-kit";

/**
 * Drizzle migrations.
 *
 *   pnpm db:generate — diff src/lib/db/schema.ts against drizzle/meta and emit
 *                      the next SQL migration into drizzle/.
 *   pnpm db:migrate  — apply pending drizzle/ migrations to the DB named by
 *                      DATABASE_URL (dev/prod both use `drizzle-kit migrate`).
 *   pnpm db:push     — push the schema directly (dev only; skip in prod).
 *
 * `generate` never connects to a database. `migrate`/`push` read DATABASE_URL
 * from the environment; there is intentionally NO localhost fallback so a
 * missing URL fails loudly instead of silently targeting a local DB.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
