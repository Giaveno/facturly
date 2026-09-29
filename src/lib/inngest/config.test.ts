import { describe, expect, it } from "vitest";
import { resolveInngestSigningKey } from "./config";

/**
 * Inngest signing-key resolution — the security boundary for the emission + OCR
 * endpoints. Proves: production refuses to start without the key, refuses when
 * INNGEST_DEV is set, and returns the key otherwise; non-production is lenient.
 */
describe("resolveInngestSigningKey", () => {
  it("throws in production when the signing key is missing", () => {
    expect(() =>
      resolveInngestSigningKey({ NODE_ENV: "production" }),
    ).toThrow(/INNGEST_SIGNING_KEY is required in production/);
  });

  it("throws in production when INNGEST_DEV is set (even with a key)", () => {
    expect(() =>
      resolveInngestSigningKey({
        NODE_ENV: "production",
        INNGEST_SIGNING_KEY: "signkey_xxx",
        INNGEST_DEV: "1",
      }),
    ).toThrow(/INNGEST_DEV must NEVER be set in production/);
  });

  it("returns the key in production when it is set and INNGEST_DEV is absent", () => {
    expect(
      resolveInngestSigningKey({
        NODE_ENV: "production",
        INNGEST_SIGNING_KEY: "  signkey_xxx  ",
      }),
    ).toBe("signkey_xxx");
  });

  it("returns the key (or undefined) in non-production", () => {
    expect(
      resolveInngestSigningKey({
        NODE_ENV: "development",
        INNGEST_SIGNING_KEY: "signkey_xxx",
      }),
    ).toBe("signkey_xxx");
    expect(resolveInngestSigningKey({ NODE_ENV: "test" })).toBeUndefined();
  });
});
