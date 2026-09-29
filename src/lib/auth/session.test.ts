import { describe, it, expect } from "vitest";
import {
  isUnauthorizedError,
  requireAccountantSession,
  UnauthorizedError,
} from "./session";

/**
 * The accountant session seam — now resolves the REAL NextAuth session and
 * DENIES (throws UnauthorizedError) whenever there is no user. The resolver is
 * injectable so the fail-closed behaviour is testable without the Next.js
 * request runtime.
 */
describe("requireAccountantSession (fail-closed)", () => {
  it("DENIES when the session is null", async () => {
    await expect(requireAccountantSession(async () => null)).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("DENIES when the session has no user", async () => {
    await expect(requireAccountantSession(async () => ({}))).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("ALLOWS when the session has a user", async () => {
    await expect(
      requireAccountantSession(async () => ({ user: { email: "a@b.c" } })),
    ).resolves.toBeUndefined();
  });

  it("DENIES (never allows) when the session resolver REJECTS (import failure)", async () => {
    // The production resolver lazy-loads `@/auth`; if that import rejects, the
    // seam must fail CLOSED (deny), not propagate a raw error (→ 500) and never
    // silently allow.
    await expect(
      requireAccountantSession(async () => {
        throw new Error("Cannot find module '@/auth'");
      }),
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe("isUnauthorizedError", () => {
  it("recognizes the seam denial and nothing else", () => {
    expect(isUnauthorizedError(new UnauthorizedError())).toBe(true);
    expect(isUnauthorizedError(new Error("unrelated"))).toBe(false);
  });
});
