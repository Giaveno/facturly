/**
 * Credentials upload service — the "plug in ARCA" step.
 *
 * The `credentials` table holds the accountant's ONE X.509 certificate + the
 * AES-256-GCM-encrypted private key. This service is the ONLY writer of that
 * table from the upload path: it validates the pair, encrypts the key at rest
 * with `AES_KEY`, and REPLACES any prior row (a single global credential).
 *
 * Security contract (enforced here, verified by tests):
 *   - The plaintext private key exists only as the function argument; it is
 *     encrypted immediately and NEVER returned, logged, or echoed.
 *   - Only PUBLIC metadata (subject CN, a Mod-11-valid CUIT, validity window)
 *     is returned, for the accountant to confirm what he uploaded.
 *   - The audit entry carries the same public metadata only — no key, no cert.
 */

import { credentials, CREDENTIALS_SCOPE } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/audit";
import { deriveAesKey, encryptPrivateKey } from "@/lib/db/credentials";
import { DrizzleCredentialsRepository } from "@/lib/db/credentials-repository";
import type { Db } from "@/lib/db/types";
import {
  assertKeyMatchesCertificate,
  inspectCertificate,
  type CertificateInfo,
} from "./pem";

export interface CredentialsUploadInput {
  certPem: string;
  keyPem: string;
}

/**
 * Validates the certificate/key pair, encrypts the private key at rest, and
 * replaces the single global credential row. Returns the certificate's public
 * metadata (subject/CUIT/expiry) — never key material.
 */
export async function saveCredentials(
  db: Db,
  input: CredentialsUploadInput,
  aesKeyEnv: string,
): Promise<CertificateInfo> {
  // 1. Parse the certificate and read its public metadata (throws InvalidPemError).
  const info = inspectCertificate(input.certPem);

  // 2. Prove the key belongs to the certificate BEFORE encrypting (throws
  //    KeyMismatchError / InvalidPemError).
  assertKeyMatchesCertificate(input.certPem, input.keyPem);

  // 3. Encrypt the private key at rest with AES-256-GCM (throws on a bad AES_KEY).
  const key = deriveAesKey(aesKeyEnv);
  const enc = encryptPrivateKey(input.keyPem, key);

  // 4. Upsert the single global credential row on the constant `scope` key.
  //    The DB unique index on `scope` is the physical single-row guard: two
  //    concurrent uploads cannot both insert (one conflicts and updates), so
  //    the signing identity can never be silently ambiguous (W2).
  await db
    .insert(credentials)
    .values({
      scope: CREDENTIALS_SCOPE,
      certPem: input.certPem,
      keyCiphertext: enc.keyCiphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    })
    .onConflictDoUpdate({
      target: credentials.scope,
      set: {
        certPem: input.certPem,
        keyCiphertext: enc.keyCiphertext,
        iv: enc.iv,
        authTag: enc.authTag,
      },
    });

  // 5. Audit the replacement with PUBLIC metadata only (never key/cert PEM).
  await writeAudit(db, {
    actor: "accountant",
    action: "credentials.updated",
    payload: { subjectCn: info.subjectCn, cuit: info.cuit, notAfter: info.notAfter },
  });

  return info;
}

/**
 * Reads the currently provisioned certificate's PUBLIC metadata (subject/CUIT/
 * validity window), or null when no credential row exists. The private key is
 * never loaded or decrypted here — this is the read side for the upload screen.
 */
export async function getCredentialInfo(db: Db): Promise<CertificateInfo | null> {
  const stored = await new DrizzleCredentialsRepository(db).get();
  if (!stored) return null;
  return inspectCertificate(stored.certPem);
}
