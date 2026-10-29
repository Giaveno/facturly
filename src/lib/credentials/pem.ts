/**
 * ARCA certificate + private-key PEM validation — the upload-time "plug in
 * ARCA" gate (pure `node:crypto`, no network, no homologación).
 *
 * The accountant uploads ONE X.509 certificate + the matching private key. Two
 * things must be proven BEFORE anything is encrypted and persisted:
 *
 *   1. Both PEMs actually parse (a typo'd paste must be caught here, not at
 *      WSAA `LoginCms` time).
 *   2. The private key really corresponds to the certificate's public key. An
 *      unmatched pair would sign a TRA that ARCA rejects — or worse, emit with
 *      the wrong identity. Rejecting the mismatch at upload is far cheaper.
 *
 * The returned `CertificateInfo` (subject CN, a Mod-11-valid CUIT if the
 * subject carries one, and the validity window) is what the accountant confirms
 * he uploaded. It NEVER contains key material — the plaintext key is not
 * inspectable through this module's return values.
 */

import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { isValidCuit } from "@/domain/cuit";
import { certificateFingerprint } from "@/adapters/arca/credential-ta-cache";

/** Thrown when a PEM cannot be parsed as the expected object (mapped to 400). */
export class InvalidPemError extends Error {
  constructor(kind: "certificate" | "private key") {
    super(`The uploaded ${kind} PEM is invalid or unparseable`);
    this.name = "InvalidPemError";
  }
}

/** Thrown when the private key does not belong to the certificate (mapped to 400). */
export class KeyMismatchError extends Error {
  constructor() {
    super("The private key does not match the uploaded certificate");
    this.name = "KeyMismatchError";
  }
}

/** Public metadata about an uploaded certificate (never key material). */
export interface CertificateInfo {
  fingerprint: string;
  /** The certificate subject's Common Name. */
  subjectCn: string;
  /** A Mod-11-valid CUIT found in the subject, or null. */
  cuit: string | null;
  /** The certificate's notBefore instant (string, parseable by Date.parse). */
  notBefore: string;
  /** The certificate's notAfter instant (string, parseable by Date.parse). */
  notAfter: string;
}

/** Parses a PEM certificate, throwing `InvalidPemError` on failure. */
export function parseCertificatePem(certPem: string): X509Certificate {
  try {
    return new X509Certificate(certPem);
  } catch {
    throw new InvalidPemError("certificate");
  }
}

/** Parses a PEM private key, throwing `InvalidPemError` on failure. */
export function parsePrivateKeyPem(keyPem: string): KeyObject {
  try {
    return createPrivateKey(keyPem);
  } catch {
    throw new InvalidPemError("private key");
  }
}

/**
 * True when the private key belongs to the certificate. Compares the
 * SubjectPublicKeyInfo (SPKI) DER of the certificate's public key against the
 * public key derived from the private key — an exact, deterministic match for
 * RSA/EC without relying on a sign/verify round-trip.
 */
export function keyMatchesCertificate(certPem: string, keyPem: string): boolean {
  const cert = parseCertificatePem(certPem);
  const key = parsePrivateKeyPem(keyPem);
  const certSpki = cert.publicKey.export({ type: "spki", format: "der" });
  const keySpki = createPublicKey(key).export({ type: "spki", format: "der" });
  return certSpki.equals(keySpki);
}

/** Asserts the pair matches, throwing `KeyMismatchError` otherwise. */
export function assertKeyMatchesCertificate(
  certPem: string,
  keyPem: string,
): void {
  if (!keyMatchesCertificate(certPem, keyPem)) {
    throw new KeyMismatchError();
  }
}

/**
 * Scans a certificate subject string for a Mod-11-valid 11-digit CUIT. ARCA
 * certs carry the accountant's CUIT in the subject (commonly the CN or the
 * serialNumber), so a best-effort scan is the reliable way to surface it for
 * confirmation without hard-coding a field name.
 */
function extractCuit(subject: string): string | null {
  const matches = subject.match(/\d[\d.\-/ ]{9,13}\d/g) ?? [];
  for (const m of matches) {
    const digits = m.replace(/[^0-9]/g, "");
    if (digits.length === 11 && isValidCuit(digits)) return digits;
  }
  return null;
}

/** Extracts the subject's Common Name from the `X509Certificate.subject` string. */
function extractSubjectCn(subject: string): string {
  const cn = subject.match(/CN=([^\n,]+)/);
  return cn ? cn[1]!.trim() : "";
}

/** Inspects an uploaded certificate and returns its public metadata. */
export function inspectCertificate(certPem: string): CertificateInfo {
  const cert = parseCertificatePem(certPem);
  const subject = cert.subject;
  return {
    fingerprint: certificateFingerprint(certPem),
    subjectCn: extractSubjectCn(subject),
    cuit: extractCuit(subject),
    notBefore: cert.validFrom,
    notAfter: cert.validTo,
  };
}
