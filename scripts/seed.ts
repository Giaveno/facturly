/**
 * Seed the single accountant — `pnpm db:seed`.
 *
 * Reads ACCOUNTANT_EMAIL and ACCOUNTANT_PASSWORD from the environment and
 * upserts the accountant row (hashing the password with bcrypt). Requires a
 * reachable DATABASE_URL (Neon). Credentials are NEVER hardcoded here; the
 * password is hashed immediately and never logged.
 *
 *   ACCOUNTANT_EMAIL=contador@example.com \
 *   ACCOUNTANT_PASSWORD='...' \
 *   pnpm db:seed
 */

import { getDb } from "../src/lib/db/client";
import { seedAccountant } from "../src/lib/auth/seed";

async function main(): Promise<void> {
  const email = process.env.ACCOUNTANT_EMAIL?.trim();
  const password = process.env.ACCOUNTANT_PASSWORD;

  if (!email || !password) {
    console.error(
      "ACCOUNTANT_EMAIL and ACCOUNTANT_PASSWORD must both be set in the environment",
    );
    process.exit(1);
  }

  const result = await seedAccountant(getDb(), { email, password });
  console.log(
    `Accountant ${result.created ? "created" : "updated"}: ${email}`,
  );
}

main().catch((err) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
