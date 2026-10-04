import { describe, it, expect } from "vitest";
import { decideAuthResponse, isExemptPath } from "./middleware-policy";

/**
 * Middleware policy — the pure decision logic behind the session middleware.
 * `isExemptPath` is the single source of truth for which paths the middleware
 * must NOT block; `decideAuthResponse` maps (loggedIn, pathname) to the right
 * outcome (allow / redirect / 401).
 */
describe("isExemptPath — routes the middleware must never block", () => {
  it.each([
    "/api/auth/signin",
    "/api/auth/callback/credentials",
    "/api/auth/session",
    "/api/auth",
    "/api/auth/",
    "/api/inngest",
    "/api/inngest/",
    "/api/inngest/events",
    "/login",
    "/login/",
    "/_next/static/chunk.js",
    "/favicon.ico",
  ])("exempts %s", (pathname) => {
    expect(isExemptPath(pathname)).toBe(true);
  });

  it.each([
    "/",
    "/review",
    "/invoices",
    "/clients",
    "/credentials",
    "/api/upload",
    "/api/clients",
    "/api/credentials",
    "/api/rows/00000000-0000-4000-8000-000000000000/resolve-payer",
    "/api/clients/00000000-0000-4000-8000-000000000000/delegation",
    // NOT NextAuth routes — a prefix match must NOT exempt these.
    "/api/authz",
    "/api/authentication",
    "/api/authx/whatever",
    "/api/invoices/00000000-0000-4000-8000-000000000000/pdf",
    "/api/invoices/00000000-0000-4000-8000-000000000000/approve",
    "/api/invoices/00000000-0000-4000-8000-000000000000/review",
  ])("does NOT exempt %s (protected)", (pathname) => {
    expect(isExemptPath(pathname)).toBe(false);
  });
});

describe("decideAuthResponse — allow / redirect / 401", () => {
  it("allows when logged in (page or API)", () => {
    expect(decideAuthResponse({ isLoggedIn: true, pathname: "/review" })).toEqual(
      { kind: "next" },
    );
    expect(decideAuthResponse({ isLoggedIn: true, pathname: "/api/upload" })).toEqual(
      { kind: "next" },
    );
  });

  it("redirects an unauthenticated PAGE request to /login", () => {
    expect(
      decideAuthResponse({ isLoggedIn: false, pathname: "/invoices" }),
    ).toEqual({ kind: "redirect", to: "/login" });
  });

  it("returns 401 (not a redirect) for an unauthenticated API request", () => {
    expect(
      decideAuthResponse({ isLoggedIn: false, pathname: "/api/upload" }),
    ).toEqual({ kind: "unauthorized" });
    expect(
      decideAuthResponse({ isLoggedIn: false, pathname: "/api/invoices/abc/pdf" }),
    ).toEqual({ kind: "unauthorized" });
  });
});
