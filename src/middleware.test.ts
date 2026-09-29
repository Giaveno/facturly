import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isExemptPath } from "@/lib/auth/middleware-policy";

/**
 * Middleware matcher ↔ policy agreement (G2).
 *
 * The middleware `config.matcher` decides WHICH paths even reach the middleware;
 * `isExemptPath` decides which of those the middleware lets through. They can
 * drift: if the matcher silently skips a path that `isExemptPath` would PROTECT,
 * that path loses its auth gate.
 *
 * Next.js requires the matcher to be an inline LITERAL (it cannot follow an
 * imported constant — `Unknown identifier` at build), and importing
 * `@/middleware` in the offline Vitest node env fails on `next-auth` →
 * `next/server`. So this test reads the REAL literal out of `src/middleware.ts`
 * and asserts agreement with `isExemptPath` over a shared path list — if either
 * side drifts, the test fails.
 *
 * The matcher is anchored with `^` because its negative lookahead is meant to
 * apply at the start of the pathname (the leading `/`).
 */

function readMatcherLiteral(): string {
  const src = readFileSync(
    fileURLToPath(new URL("./middleware.ts", import.meta.url)),
    "utf8",
  );
  const block = src.match(/matcher:\s*\[([^\]]*)\]/);
  if (!block) throw new Error("could not locate the matcher array in middleware.ts");
  const literal = block[1]!.match(/["']([^"']+)["']/);
  if (!literal) throw new Error("could not parse the matcher string literal");
  return literal[1]!;
}

function middlewareSkips(pathname: string): boolean {
  const re = new RegExp("^" + readMatcherLiteral());
  return !re.test(pathname);
}

describe("middleware matcher ↔ isExemptPath agreement", () => {
  const EXEMPT_PATHS = [
    "/api/auth",
    "/api/auth/",
    "/api/auth/signin",
    "/api/auth/callback/credentials",
    "/api/auth/session",
    "/api/inngest",
    "/api/inngest/",
    "/login",
    "/login/",
    "/_next/static/chunk.js",
    "/_next/image/avatar.png",
    "/favicon.ico",
  ];

  const PROTECTED_PATHS = [
    "/",
    "/review",
    "/invoices",
    "/clients",
    "/api/upload",
    // NOT NextAuth routes — the narrowed exemption must NOT let these through.
    "/api/authz",
    "/api/authentication",
    "/api/invoices/00000000-0000-4000-8000-000000000000/pdf",
    "/api/invoices/00000000-0000-4000-8000-000000000000/approve",
  ];

  it("never lets the matcher skip a path the policy would protect", () => {
    // The security-critical invariant: any path the matcher EXCLUDES (skips)
    // must ALSO be exempted by the policy. If the matcher skips a protected path,
    // auth silently vanishes for it.
    for (const p of [...EXEMPT_PATHS, ...PROTECTED_PATHS]) {
      if (middlewareSkips(p)) {
        expect(
          isExemptPath(p),
          `matcher skips "${p}" but isExemptPath would PROTECT it`,
        ).toBe(true);
      }
    }
  });

  it("runs the middleware for protected paths and does NOT exempt them", () => {
    for (const p of PROTECTED_PATHS) {
      expect(middlewareSkips(p), `matcher must run for "${p}"`).toBe(false);
      expect(isExemptPath(p), `policy must NOT exempt "${p}"`).toBe(false);
    }
  });

  it("does NOT exempt the narrowed non-auth prefixes (/api/authz etc.)", () => {
    // These must reach the middleware AND be protected — the whole point of
    // narrowing `/api/auth` from a prefix to an exact/segment match.
    expect(isExemptPath("/api/authz")).toBe(false);
    expect(isExemptPath("/api/authentication")).toBe(false);
    expect(middlewareSkips("/api/authz")).toBe(false);
    expect(middlewareSkips("/api/authentication")).toBe(false);
  });
});
