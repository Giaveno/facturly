/**
 * AES-256-GCM encryption for the ARCA X.509 private key at rest.
 *
 * The accountant's certificate PEM is public and may be stored plaintext; the
 * PRIVATE KEY must NEVER be stored or logged in plaintext. This module
 * encrypts/decrypts the private key with AES-256-GCM, keyed from the `AES_KEY`
 * environment variable (32 bytes, hex- or base64-encoded).
 *
 * The persisted shape matches the `credentials` table columns: `key_ciphertext`
 * (ciphertext), `iv` (nonce), and `auth_tag` (GCM authentication tag). GCM is
 * an authenticated mode: any tampering with the ciphertext, IV, or tag causes
 * decryption to throw rather than silently producing garbage.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

/** Encrypted private key — the persisted form (base64 fields). */
export interface EncryptedPrivateKey {
  /** AES-GCM ciphertext (base64). */
  keyCiphertext: string;
  /** AES-GCM 12-byte nonce (base64). */
  iv: string;
  /** AES-GCM 16-byte authentication tag (base64). */
  authTag: string;
}

const AES_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Derives the 32-byte AES key from the `AES_KEY` env var. Accepts either a
 * 64-char hex string or base64; both must decode to exactly 32 bytes (256 bits).
 *
 * Generate one with: `openssl rand -hex 32` (hex) or `openssl rand -base64 32`.
 */
export function deriveAesKey(envValue: string): Buffer {
  const trimmed = envValue.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `AES_KEY must decode to ${KEY_BYTES} bytes (256 bits), got ${decoded.length}`,
    );
  }
  return decoded;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `AES-256-GCM requires a ${KEY_BYTES}-byte key, got ${key.length}`,
    );
  }
}

/**
 * Encrypts a plaintext private key. The IV (nonce) is freshly random on every
 * call, so identical plaintext never produces identical ciphertext.
 */
export function encryptPrivateKey(
  plaintext: string,
  key: Buffer,
): EncryptedPrivateKey {
  assertKeyLength(key);
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Unexpected GCM auth tag length");
  }
  return {
    keyCiphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypts a private key. Throws on tampering (GCM auth failure) or a wrong
 * key — there is no silent garbage output.
 */
export function decryptPrivateKey(
  enc: EncryptedPrivateKey,
  key: Buffer,
): string {
  assertKeyLength(key);
  const decipher: DecipherGCM = createDecipheriv(
    AES_ALGORITHM,
    key,
    Buffer.from(enc.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(enc.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(enc.keyCiphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
