/**
 * Credential verification — the ONLY code that compares a submitted password
 * against the accountant's stored bcrypt hash. It is deliberately a plain async
 * function (no Next.js coupling) so it is testable against PGlite and reusable
 * by both the NextAuth credentials provider and the seed workflow.
 *
 * Security: the password is compared with a constant-time bcrypt compare, never
 * logged, never echoed, and the hash is never returned — only `{ id, email }`.
 */

import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { accountant } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** The authenticated accountant's identity (no password material). */
export interface AccountantIdentity {
  id: string;
  email: string;
}

/** Normalizes an email for storage/compare: trimmed + lowercased. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A precomputed bcrypt hash (cost 12) of a throwaway string. Compared against on
 * the "unknown email" path so that an unknown account and a wrong password take
 * comparable time — this removes the timing oracle that would otherwise let an
 * attacker enumerate which emails exist.
 */
const DUMMY_HASH = "$2b$12$Wd43VRMDA.iekFTphNsJnuF9hRSrq7SQgHPvxK7vqE73IxQlpA63G";

/**
 * Verifies email + password against the `accountant` table. Returns the
 * accountant identity on success, or `null` when the email is unknown OR the
 * password is wrong (indistinguishable — no account enumeration).
 */
export async function verifyAccountantCredentials(
  db: Db,
  email: string,
  password: string,
): Promise<AccountantIdentity | null> {
  const normalized = normalizeEmail(email);
  if (normalized === "" || password === "") {
    return null;
  }

  const [row] = await db
    .select()
    .from(accountant)
    .where(eq(accountant.email, normalized))
    .limit(1);
  if (!row) {
    // Burn a bcrypt compare against a dummy hash so the unknown-email path is
    // timing-indistinguishable from the wrong-password path (no enumeration).
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  // A NULL/empty hash can NEVER authenticate (corrupt row). Guard before
  // handing it to bcrypt.compare, which would otherwise throw.
  if (!row.passwordHash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  const valid = await bcrypt.compare(password, row.passwordHash);
  if (!valid) {
    return null;
  }

  return { id: row.id, email: row.email };
}
