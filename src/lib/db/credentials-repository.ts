/**
 * Credentials repository — loads the accountant's ARCA X.509 certificate + the
 * AES-encrypted private key from the `credentials` table and decrypts the key
 * just-in-time. This is what makes the "encryption at rest" guarantee real
 * instead of dead code: the production factory consumes an `AES_KEY`-backed
 * provider, never a plaintext `keyPem`.
 *
 * Security: the decrypted key exists only in memory for the duration of the
 * `WsaaCredentials` resolution. It is NEVER logged.
 */

import { credentials } from "./schema";
import type { Db } from "./types";
import {
  decryptPrivateKey,
  deriveAesKey,
  type EncryptedPrivateKey,
} from "./credentials";

/** The persisted credential row (cert PEM + encrypted private key). */
export interface StoredCredentials {
  certPem: string;
  encryptedKey: EncryptedPrivateKey;
}

/** Loads the single accountant credential row. */
export interface CredentialsRepository {
  get(): Promise<StoredCredentials | null>;
}

/** Drizzle `credentials` implementation of the repository port. */
export class DrizzleCredentialsRepository implements CredentialsRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get(): Promise<StoredCredentials | null> {
    const row = await this.db.query.credentials.findFirst({
      orderBy: (_t, { asc }) => [asc(credentials.id)],
    });
    if (!row) return null;
    return {
      certPem: row.certPem,
      encryptedKey: {
        keyCiphertext: row.keyCiphertext,
        iv: row.iv,
        authTag: row.authTag,
      },
    };
  }
}

/**
 * Builds a `WsaaCredentialsProvider` that loads the stored row and decrypts the
 * private key just-in-time with `AES_KEY`. Throws a clear error when no row is
 * provisioned (fail loud, never fall back to a plaintext key).
 */
export function credentialsProvider(
  repository: CredentialsRepository,
  aesKeyEnv: string,
): () => Promise<{ certPem: string; keyPem: string }> {
  return async () => {
    const key = deriveAesKey(aesKeyEnv);
    const stored = await repository.get();
    if (!stored) {
      throw new Error(
        "No ARCA credentials row provisioned — cannot obtain the private key",
      );
    }
    return {
      certPem: stored.certPem,
      keyPem: decryptPrivateKey(stored.encryptedKey, key),
    };
  };
}
