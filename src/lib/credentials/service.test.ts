import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { auditLog, credentials, CREDENTIALS_SCOPE } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { KeyMismatchError } from "./pem";
import { getCredentialInfo, saveCredentials } from "./service";

const HEX_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("credentials service — encrypt-at-rest upload", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(credentials);
  });

  afterAll(async () => {
    await close();
  });

  it("encrypts the private key at rest and returns only public metadata", async () => {
    const pair = generateSelfSignedCert("ESTUDIO S.A. CUIT 30710145764");
    const info = await saveCredentials(
      db,
      { certPem: pair.certPem, keyPem: pair.keyPem },
      HEX_KEY,
    );

    // Returned metadata is public — NEVER the key.
    expect(info.subjectCn).toBe("ESTUDIO S.A. CUIT 30710145764");
    expect(info.cuit).toBe("30710145764");
    expect(JSON.stringify(info)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(info)).not.toContain(pair.keyPem);

    const [row] = await db.select().from(credentials);
    expect(row).toBeDefined();
    // The stored ciphertext must NOT contain the plaintext key.
    expect(row!.keyCiphertext).not.toContain("BEGIN PRIVATE KEY");
    expect(row!.keyCiphertext).not.toContain("PRIVATE KEY");

    // …and the key is recoverable ONLY with AES_KEY (proves it is really there,
    // encrypted, not just thrown away).
    const decrypted = decryptPrivateKey(
      { keyCiphertext: row!.keyCiphertext, iv: row!.iv, authTag: row!.authTag },
      deriveAesKey(HEX_KEY),
    );
    expect(decrypted).toBe(pair.keyPem);
  });

  it("rejects an unmatched key/cert pair and persists NOTHING", async () => {
    const pair = generateSelfSignedCert("CORRECT S.A.");
    const other = generateSelfSignedCert("OTHER S.A.");

    await expect(
      saveCredentials(db, { certPem: pair.certPem, keyPem: other.keyPem }, HEX_KEY),
    ).rejects.toThrow(KeyMismatchError);

    const rows = await db.select().from(credentials);
    expect(rows).toHaveLength(0);
  });

  it("replaces any previous credential row (single global credential)", async () => {
    const first = generateSelfSignedCert("FIRST S.A.");
    await saveCredentials(db, { certPem: first.certPem, keyPem: first.keyPem }, HEX_KEY);

    const second = generateSelfSignedCert("SECOND S.A. CUIT 20123456786");
    await saveCredentials(
      db,
      { certPem: second.certPem, keyPem: second.keyPem },
      HEX_KEY,
    );

    const rows = await db.select().from(credentials);
    expect(rows).toHaveLength(1);
    // The row is a singleton keyed by the constant `scope` (W2).
    expect(rows[0]!.scope).toBe(CREDENTIALS_SCOPE);
    const decrypted = decryptPrivateKey(
      { keyCiphertext: rows[0]!.keyCiphertext, iv: rows[0]!.iv, authTag: rows[0]!.authTag },
      deriveAesKey(HEX_KEY),
    );
    expect(decrypted).toBe(second.keyPem);
  });

  it("never logs the private key (console.error stays clean on success and failure)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pair = generateSelfSignedCert("LOG S.A. CUIT 30710145764");

      // A successful save must not log the key.
      await saveCredentials(db, { certPem: pair.certPem, keyPem: pair.keyPem }, HEX_KEY);

      // A rejected (mismatched) save must not log the key either.
      const other = generateSelfSignedCert("OTHER S.A.");
      await expect(
        saveCredentials(db, { certPem: pair.certPem, keyPem: other.keyPem }, HEX_KEY),
      ).rejects.toThrow(KeyMismatchError);

      const logged = spy.mock.calls
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(logged).not.toContain(pair.keyPem);
      expect(logged).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      spy.mockRestore();
    }
  });

  it("writes an audit entry with public metadata and NO key/cert material", async () => {
    const pair = generateSelfSignedCert("AUDIT S.A. CUIT 30710145764");
    await saveCredentials(db, { certPem: pair.certPem, keyPem: pair.keyPem }, HEX_KEY);

    const audits = await db.select().from(auditLog).where(
      eq(auditLog.action, "credentials.updated"),
    );
    expect(audits).toHaveLength(1);
    const payload = JSON.stringify(audits[0]!.payload);
    expect(payload).not.toContain("BEGIN PRIVATE KEY");
    expect(payload).not.toContain("BEGIN CERTIFICATE");
    expect(payload).not.toContain(pair.keyPem);
    expect(payload).not.toContain(pair.certPem);
  });

  it("getCredentialInfo returns public metadata and null when nothing is provisioned", async () => {
    expect(await getCredentialInfo(db)).toBeNull();

    const pair = generateSelfSignedCert("READ S.A. CUIT 30710145764");
    await saveCredentials(db, { certPem: pair.certPem, keyPem: pair.keyPem }, HEX_KEY);

    const info = await getCredentialInfo(db);
    expect(info).not.toBeNull();
    expect(info!.subjectCn).toBe("READ S.A. CUIT 30710145764");
    expect(info!.cuit).toBe("30710145764");
    // The read side must never expose the key or the raw cert.
    expect(JSON.stringify(info)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(info)).not.toContain("BEGIN CERTIFICATE");
  });
});
