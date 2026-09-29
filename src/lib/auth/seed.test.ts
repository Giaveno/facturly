import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { accountant } from "@/lib/db/schema";
import { seedAccountant } from "./seed";
import type { Db } from "@/lib/db/types";

/**
 * Accountant seeding — creates/updates the single accountant, hashing the
 * password with bcrypt. Proves: the stored value is a bcrypt hash (never the
 * plaintext), re-seeding UPDATES in place (idempotent upsert, never a second
 * row), and the email is normalized.
 */
describe("seedAccountant", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(accountant);
  });

  afterAll(async () => {
    await close();
  });

  it("creates the accountant with a bcrypt hash (never plaintext)", async () => {
    const { created } = await seedAccountant(db, {
      email: "contador@example.com",
      password: "s3cret",
    });

    expect(created).toBe(true);

    const [row] = await db.select().from(accountant);
    expect(row).toBeDefined();
    expect(row!.email).toBe("contador@example.com");
    // The stored hash must NOT be the plaintext, and must verify with bcrypt.
    expect(row!.passwordHash).not.toBe("s3cret");
    expect(await bcrypt.compare("s3cret", row!.passwordHash)).toBe(true);
  });

  it("updates in place on re-seed (upsert, never a second row)", async () => {
    await seedAccountant(db, { email: "contador@example.com", password: "first" });
    const [before] = await db
      .select()
      .from(accountant)
      .where(eq(accountant.email, "contador@example.com"));

    // Re-seed with a differently-cased email and a new password.
    const { created } = await seedAccountant(db, {
      email: "CONTADOR@EXAMPLE.COM",
      password: "second",
    });

    expect(created).toBe(false);
    const rows = await db.select().from(accountant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(await bcrypt.compare("second", rows[0]!.passwordHash)).toBe(true);
    expect(await bcrypt.compare("first", rows[0]!.passwordHash)).toBe(false);
  });
});
