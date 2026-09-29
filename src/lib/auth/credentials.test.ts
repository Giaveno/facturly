import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { createTestDb } from "@/test-support/test-db";
import { accountant } from "@/lib/db/schema";
import { verifyAccountantCredentials } from "./credentials";
import type { Db } from "@/lib/db/types";

/**
 * Credential verification — the ONLY code that ever compares a password against
 * the stored bcrypt hash. Tests prove: correct creds → the accountant (never the
 * hash), wrong password → null, unknown email → null, and email is normalized
 * (case/whitespace-insensitive) so a typo in casing still matches.
 */
describe("verifyAccountantCredentials", () => {
  let db: Db;
  let close: () => Promise<void>;
  const email = "contador@example.com";
  const password = "s3cret-passw0rd";

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(accountant);
  });

  afterAll(async () => {
    await close();
  });

  it("returns the accountant (id + email) for correct credentials", async () => {
    const hash = await bcrypt.hash(password, 12);
    await db.insert(accountant).values({ email, passwordHash: hash });

    const result = await verifyAccountantCredentials(db, email, password);

    expect(result).not.toBeNull();
    expect(result!.email).toBe(email);
    expect(typeof result!.id).toBe("string");
    // The password hash must NEVER leak through the return value.
    expect(JSON.stringify(result)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain(hash);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("returns null for a wrong password", async () => {
    const hash = await bcrypt.hash(password, 12);
    await db.insert(accountant).values({ email, passwordHash: hash });

    await expect(
      verifyAccountantCredentials(db, email, "wrong-password"),
    ).resolves.toBeNull();
  });

  it("returns null for an unknown email", async () => {
    await expect(
      verifyAccountantCredentials(db, "nobody@example.com", password),
    ).resolves.toBeNull();
  });

  it("normalizes email (trim + lowercase) before matching", async () => {
    const hash = await bcrypt.hash(password, 12);
    await db.insert(accountant).values({ email, passwordHash: hash });

    const result = await verifyAccountantCredentials(
      db,
      "  CONTADOR@EXAMPLE.COM  ",
      password,
    );
    expect(result).not.toBeNull();
    expect(result!.email).toBe(email);
  });

  it("returns null (never authenticates) for an empty password hash", async () => {
    // A corrupt row with an empty hash must NEVER authenticate, and must not
    // throw — bcrypt.compare would otherwise choke on an invalid hash.
    await db.insert(accountant).values({ email, passwordHash: "" });

    await expect(
      verifyAccountantCredentials(db, email, password),
    ).resolves.toBeNull();
  });
});
