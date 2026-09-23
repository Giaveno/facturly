/**
 * Test-support PKCS#7 tooling: generates a self-signed fixture certificate and
 * independently verifies a CMS SignedData signature using Node's `crypto`
 * module (NOT node-forge's own verify, which is unimplemented).
 *
 * Why this exists: WSAA's `LoginCms` signs the TRA with CMS/PKCS#7, but ARCA
 * publishes no public test vectors. The honest offline boundary is a
 * SELF-CONSISTENCY round-trip — sign with node-forge, then verify with an
 * independent implementation. `verifyCmsSignature` reconstructs the exact DER
 * `SET OF authenticatedAttributes` bytes that RFC 2315/5652 requires the RSA
 * signature to cover, and verifies it against the certificate's public key.
 *
 * This proves the CMS is structurally well-formed and the signature is a REAL
 * RSA-SHA256 signature over the right content. It does NOT prove ARCA will
 * accept it — that is only provable in homologación.
 */

import * as forge from "node-forge";
import { createHash, verify as cryptoVerify } from "node:crypto";

/** A self-signed X.509 fixture (cert + key + public key) for offline tests. */
export interface FixtureKeyPair {
  certPem: string;
  keyPem: string;
  publicKeyPem: string;
}

const MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";

/** Generates a self-signed RSA-2048 X.509 certificate for offline signing. */
export function generateSelfSignedCert(cn = "fixture.example.com"): FixtureKeyPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
  };
}

/** Result of an independent CMS signature verification. */
export interface IndependentVerification {
  /** The embedded signed content (the TRA XML), as UTF-8. */
  content: string;
  /** The signer's digest algorithm OID (e.g. sha256). */
  digestAlgorithm: string;
  /** True when the RSA signature verifies against the given public key. */
  signatureValid: boolean;
  /** True when the embedded messageDigest attribute equals SHA-256(content). */
  messageDigestMatches: boolean;
  /** True when the SignedData carries the signer's certificate. */
  signerCertPresent: boolean;
}

/**
 * Independently verifies a base64 CMS SignedData. Throws if the input is not a
 * well-formed PKCS#7 SignedData (the "well-formed" assertion lives here).
 */
export function verifyCmsSignature(
  base64Cms: string,
  publicKeyPem: string,
): IndependentVerification {
  const der = Buffer.from(base64Cms, "base64");
  const msg = forge.pkcs7.messageFromAsn1(
    forge.asn1.fromDer(der.toString("binary")),
  );
  const rc = msg.rawCapture;

  // Embedded content is the [0] EXPLICIT OCTET STRING's bytes.
  const content = Buffer.from(rc.content.value[0].value, "binary").toString(
    "utf8",
  );

  const digestAlgorithm = forge.asn1.derToOid(rc.digestAlgorithm);

  // Reconstruct the exact DER SET OF authenticatedAttributes that was signed.
  const attrsSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    rc.authenticatedAttributes,
  );
  const signedBytes = Buffer.from(
    forge.asn1.toDer(attrsSet).getBytes(),
    "binary",
  );
  const signature = Buffer.from(rc.signature, "binary");

  const signatureValid = cryptoVerify(
    "RSA-SHA256",
    signedBytes,
    publicKeyPem,
    signature,
  );

  // Locate the messageDigest attribute and compare it to SHA-256(content).
  let claimedDigest: string | undefined;
  for (const attr of rc.authenticatedAttributes) {
    const oid = forge.asn1.derToOid(attr.value[0].value);
    if (oid === MESSAGE_DIGEST_OID) {
      const octet = attr.value[1].value[0];
      claimedDigest = Buffer.from(octet.value, "binary").toString("hex");
    }
  }
  const realDigest = createHash("sha256").update(content, "utf8").digest("hex");

  return {
    content,
    digestAlgorithm,
    signatureValid,
    messageDigestMatches:
      claimedDigest !== undefined && claimedDigest === realDigest,
    signerCertPresent: rc.certificates !== undefined,
  };
}
