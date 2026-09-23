import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { credentials } from "./schema";
import type { Db } from "./types";
import {
  DrizzleCredentialsRepository,
  credentialsProvider,
} from "./credentials-repository";
import { deriveAesKey, encryptPrivateKey } from "./credentials";

const HEX_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const PRIVATE_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7vTqQ8gR3yZ9x",
  "PLACEHOLDERKEYMATERIAL",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("credentials-repository (encryption-at-rest is REAL, not dead code)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  it("loads the stored row and decrypts the private key just-in-time", async () => {
    const key = deriveAesKey(HEX_KEY);
    const enc = encryptPrivateKey(PRIVATE_KEY_PEM, key);

    await db.insert(credentials).values({
      certPem: "-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----",
      keyCiphertext: enc.keyCiphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    });

    const repo = new DrizzleCredentialsRepository(db);
    const provider = credentialsProvider(repo, HEX_KEY);
    const resolved = await provider();

    expect(resolved.certPem).toContain("BEGIN CERTIFICATE");
    expect(resolved.keyPem).toBe(PRIVATE_KEY_PEM);
  });

  it("fails loudly when no credential row is provisioned", async () => {
    const empty = new DrizzleCredentialsRepository(db);
    // Wipe any rows first.
    await db.delete(credentials);

    const provider = credentialsProvider(empty, HEX_KEY);
    await expect(provider()).rejects.toThrow(/No ARCA credentials row/);
  });
});
