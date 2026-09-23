import { describe, it, expect } from "vitest";
import {
  decryptPrivateKey,
  deriveAesKey,
  encryptPrivateKey,
} from "./credentials";

const HEX_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const BASE64_KEY = Buffer.from(HEX_KEY, "hex").toString("base64");

// A recognizable RSA private-key PEM (NOT a real key) — chosen so the test can
// assert the plaintext never leaks into the ciphertext/iv/authTag.
const PRIVATE_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7vTqQ8gR3yZ9x",
  "REPLACEDWITHFAKERSAKEYMATERIALPLACEHOLDER1234567890ABCDEFGHIJKLMNOPQRST",
  "-----END PRIVATE KEY-----",
].join("\n");

describe("credentials — AES-256-GCM encryption at rest", () => {
  it("derives a 32-byte key from a 64-char hex AES_KEY", () => {
    const key = deriveAesKey(HEX_KEY);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(HEX_KEY);
  });

  it("derives a 32-byte key from a base64 AES_KEY", () => {
    const key = deriveAesKey(BASE64_KEY);
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(HEX_KEY);
  });

  it("rejects an AES_KEY that does not decode to exactly 32 bytes", () => {
    expect(() => deriveAesKey("tooshort")).toThrow();
    // 64 chars of a non-hex char: not a valid hex key, and not valid base64 → <32 bytes.
    expect(() => deriveAesKey("g".repeat(64))).toThrow();
    expect(() => deriveAesKey("")).toThrow();
  });

  it("round-trips: encrypt then decrypt recovers the plaintext", () => {
    const key = deriveAesKey(HEX_KEY);
    const enc = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    expect(decryptPrivateKey(enc, key)).toBe(PRIVATE_KEY_PEM);
  });

  it("produces a fresh, non-deterministic ciphertext and IV on each encrypt", () => {
    const key = deriveAesKey(HEX_KEY);
    const a = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    const b = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    expect(a.keyCiphertext).not.toBe(b.keyCiphertext);
    expect(a.iv).not.toBe(b.iv);
    // Both must still decrypt to the same plaintext.
    expect(decryptPrivateKey(a, key)).toBe(PRIVATE_KEY_PEM);
    expect(decryptPrivateKey(b, key)).toBe(PRIVATE_KEY_PEM);
  });

  it("detects tampering (GCM auth tag failure) — flipping ciphertext bytes throws", () => {
    const key = deriveAesKey(HEX_KEY);
    const enc = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    const ct = Buffer.from(enc.keyCiphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    const tampered = { ...enc, keyCiphertext: ct.toString("base64") };
    expect(() => decryptPrivateKey(tampered, key)).toThrow();
  });

  it("fails with the wrong key", () => {
    const key = deriveAesKey(HEX_KEY);
    const otherKey = deriveAesKey(
      "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    );
    const enc = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    expect(() => decryptPrivateKey(enc, otherKey)).toThrow();
  });

  it("never stores the plaintext anywhere in the ciphertext, IV, or auth tag", () => {
    const key = deriveAesKey(HEX_KEY);
    const enc = encryptPrivateKey(PRIVATE_KEY_PEM, key);
    // The raw plaintext (and any distinctive fragment) must not appear in any
    // persisted field. This is the "never log/store the private key" guarantee.
    for (const field of [enc.keyCiphertext, enc.iv, enc.authTag]) {
      expect(field).not.toContain(PRIVATE_KEY_PEM);
      expect(field).not.toContain("BEGIN PRIVATE KEY");
      expect(field).not.toContain("REPLACEDWITHFAKERSAKEY");
    }
  });
});
