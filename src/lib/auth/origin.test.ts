import { describe, expect, it } from "vitest";
import {
  assertSameOrigin,
  collectAllowedOrigins,
  ForbiddenOriginError,
  isForbiddenOriginError,
  OriginConfigurationError,
} from "./origin";

/**
 * Same-origin (CSRF) check — the pure logic behind the state-changing routes'
 * Origin validation. Proves: a browser request with no/matching Origin passes,
 * a mismatched Origin is rejected, and the allowlist derives from the request
 * host + APP_ORIGIN.
 */
function req(init?: { host?: string; origin?: string | null }): Request {
  const headers = new Headers();
  if (init?.host !== undefined) headers.set("host", init.host);
  if (init?.origin !== undefined && init.origin !== null) {
    headers.set("origin", init.origin);
  }
  return new Request("http://example.invalid/", { headers });
}

describe("collectAllowedOrigins", () => {
  it("derives the request's own origin from host + x-forwarded-proto", () => {
    const r = new Request("http://example.invalid/", {
      headers: { host: "app.example.com", "x-forwarded-proto": "https" },
    });
    const allowed = collectAllowedOrigins(r);
    expect(allowed.has("https://app.example.com")).toBe(true);
  });

  it("adds APP_ORIGIN entries (comma-separated) to the allowlist", () => {
    const r = new Request("http://example.invalid/", {
      headers: { host: "app.example.com" },
    });
    const allowed = collectAllowedOrigins(r, {
      APP_ORIGIN: "https://a.example.com, https://b.example.com/",
    });
    expect(allowed.has("https://a.example.com")).toBe(true);
    expect(allowed.has("https://b.example.com")).toBe(true);
    // Normalization strips trailing slashes and lowercases.
    expect(allowed.has("https://B.example.com/")).toBe(false);
  });

  it("production: refuses to build the allowlist without APP_ORIGIN (W7)", () => {
    const r = new Request("http://example.invalid/", {
      headers: { host: "app.example.com" },
    });
    expect(() =>
      collectAllowedOrigins(r, { NODE_ENV: "production" }),
    ).toThrow(OriginConfigurationError);
  });

  it("production: ignores the request Host and uses only APP_ORIGIN (W7)", () => {
    // A forged Host + Origin pair must NOT be able to pass in production.
    const r = new Request("http://example.invalid/", {
      headers: { host: "evil.example.net", origin: "https://evil.example.net" },
    });
    const allowed = collectAllowedOrigins(r, {
      NODE_ENV: "production",
      APP_ORIGIN: "https://app.example.com",
    });
    expect(allowed.has("https://app.example.com")).toBe(true);
    expect(allowed.has("https://evil.example.net")).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("allows a request with no Origin header (non-browser client)", () => {
    expect(() => assertSameOrigin(req({ origin: null }))).not.toThrow();
  });

  it("allows a same-origin request", () => {
    const r = new Request("http://example.invalid/", {
      headers: { host: "app.example.com", origin: "https://app.example.com" },
    });
    expect(() => assertSameOrigin(r)).not.toThrow();
  });

  it("rejects a cross-origin request", () => {
    const r = new Request("http://example.invalid/", {
      headers: {
        host: "app.example.com",
        origin: "https://evil.example.net",
      },
    });
    expect(() => assertSameOrigin(r)).toThrow(ForbiddenOriginError);
  });

  it("allows an explicit APP_ORIGIN match", () => {
    const r = new Request("http://example.invalid/", {
      headers: { host: "app.example.com", origin: "https://legacy.example.org" },
    });
    expect(() =>
      assertSameOrigin(r, { APP_ORIGIN: "https://legacy.example.org" }),
    ).not.toThrow();
  });
});

describe("isForbiddenOriginError", () => {
  it("recognizes the CSRF rejection and nothing else", () => {
    expect(isForbiddenOriginError(new ForbiddenOriginError())).toBe(true);
    expect(isForbiddenOriginError(new Error("unrelated"))).toBe(false);
  });
});
