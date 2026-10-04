import { describe, it, expect } from "vitest";
import {
  InvalidPemError,
  KeyMismatchError,
  assertKeyMatchesCertificate,
  inspectCertificate,
  keyMatchesCertificate,
} from "./pem";
import { generateSelfSignedCert } from "@/test-support/pkcs7";

/**
 * PEM parsing + certificate/key pair validation — pure `node:crypto` logic
 * behind the ARCA credential upload. A mismatched pair must be rejected BEFORE
 * it is ever encrypted and persisted, because an unmatched pair fails at
 * emission time (much worse than a clear upload-time error).
 */
describe("pem — certificate/key parsing + pair validation", () => {
  const pair = generateSelfSignedCert(
    "ESTUDIO CONTABLE S.A. CUIT 30710145764",
  );

  it("rejects a malformed certificate PEM", () => {
    expect(() => inspectCertificate("not a certificate")).toThrow(InvalidPemError);
  });

  it("rejects a malformed private-key PEM", () => {
    expect(() => keyMatchesCertificate(pair.certPem, "not a key")).toThrow(
      InvalidPemError,
    );
  });

  it("accepts a certificate whose key matches its public key", () => {
    expect(keyMatchesCertificate(pair.certPem, pair.keyPem)).toBe(true);
    expect(() => assertKeyMatchesCertificate(pair.certPem, pair.keyPem)).not.toThrow();
  });

  it("rejects a private key that does NOT belong to the certificate", () => {
    const other = generateSelfSignedCert("OTHER S.A.");
    expect(keyMatchesCertificate(pair.certPem, other.keyPem)).toBe(false);
    expect(() => assertKeyMatchesCertificate(pair.certPem, other.keyPem)).toThrow(
      KeyMismatchError,
    );
  });

  it("extracts the subject CN from the certificate", () => {
    const info = inspectCertificate(pair.certPem);
    expect(info.subjectCn).toBe("ESTUDIO CONTABLE S.A. CUIT 30710145764");
  });

  it("extracts a Mod-11-valid CUIT from the certificate subject", () => {
    const info = inspectCertificate(pair.certPem);
    expect(info.cuit).toBe("30710145764");
  });

  it("reports a null CUIT when the subject carries no valid 11-digit CUIT", () => {
    const noCuit = generateSelfSignedCert("SOME COMPANY WITHOUT A CUIT");
    expect(inspectCertificate(noCuit.certPem).cuit).toBeNull();
  });

  it("reports the certificate validity window (notAfter in the future, notBefore in the past)", () => {
    const info = inspectCertificate(pair.certPem);
    // The fixture cert is valid for one year from generation.
    expect(Date.parse(info.notAfter)).toBeGreaterThan(Date.now());
    expect(Date.parse(info.notBefore)).toBeLessThan(Date.now());
  });
});
