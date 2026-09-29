/**
 * Accountant seeding — creates or updates the SINGLE accountant (the sole user,
 * per the spec) from explicit email + password inputs, hashing the password with
 * bcrypt before it is persisted.
 *
 * The password is handled as a plain string ONLY here (the caller's env var /
 * CLI input); it is hashed immediately and the plaintext is never stored, logged,
 * or returned. `scripts/seed.ts` is the CLI entry (`pnpm db:seed`); this module
 * stays a plain async function so it is testable against PGlite.
 */

import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { accountant } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** bcrypt work factor — 12 matches the sibling project (emitify). */
export const BCRYPT_COST = 12;

/** The seed inputs. The password is used only to compute the hash. */
export interface SeedAccountantInput {
  email: string;
  password: string;
}

export interface SeedAccountantResult {
  id: string;
  /** True when the accountant was inserted; false when an existing row updated. */
  created: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Upserts the single accountant. Idempotent: re-running with the same email
 * updates the password hash in place (never creates a second row).
 */
export async function seedAccountant(
  db: Db,
  { email, password }: SeedAccountantInput,
): Promise<SeedAccountantResult> {
  const normalized = normalizeEmail(email);
  if (normalized === "" || password === "") {
    throw new Error("seedAccountant: email and password are both required");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const [existing] = await db
    .select()
    .from(accountant)
    .where(eq(accountant.email, normalized));

  if (existing) {
    await db
      .update(accountant)
      .set({ passwordHash })
      .where(eq(accountant.id, existing.id));
    return { id: existing.id, created: false };
  }

  const [row] = await db
    .insert(accountant)
    .values({ email: normalized, passwordHash })
    .returning();
  if (!row) {
    throw new Error("seedAccountant: insert returned no row");
  }
  return { id: row.id, created: true };
}
