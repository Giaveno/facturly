import { describe, it, expect } from "vitest";
import {
  composeAuthGuard,
  selectArcaAdapter,
  selectAuthMode,
  selectDatabaseDriver,
  selectOcrAdapter,
} from "./composition";
import { UnauthorizedError } from "@/lib/auth/session";

/**
 * Composition selectors — safe defaults, fail-closed production guards, and the
 * auth seam still denying by default (Part 1 of the demo-mode slice).
 */
describe("composition — env-gated driver selection", () => {
  describe("safe defaults", () => {
    it("DATABASE_DRIVER defaults to pg", () => {
      expect(selectDatabaseDriver({})).toBe("pg");
    });

    it("ARCA_ADAPTER defaults to prod", () => {
      expect(selectArcaAdapter({})).toBe("prod");
    });

    it("OCR_ADAPTER defaults to prod", () => {
      expect(selectOcrAdapter({})).toBe("prod");
    });

    it("AUTH_MODE defaults to real", () => {
      expect(selectAuthMode({})).toBe("real");
    });
  });

  describe("production guard — refuses EVERY non-default selection", () => {
    const prod = { NODE_ENV: "production" } as const;

    it("refuses DATABASE_DRIVER=pglite under NODE_ENV=production", () => {
      expect(() =>
        selectDatabaseDriver({ ...prod, DATABASE_DRIVER: "pglite" }),
      ).toThrow(/production/);
    });

    it("refuses ARCA_ADAPTER=fake under NODE_ENV=production", () => {
      expect(() => selectArcaAdapter({ ...prod, ARCA_ADAPTER: "fake" })).toThrow(
        /production/,
      );
    });

    it("refuses OCR_ADAPTER=fake under NODE_ENV=production", () => {
      expect(() => selectOcrAdapter({ ...prod, OCR_ADAPTER: "fake" })).toThrow(
        /production/,
      );
    });

    it("refuses AUTH_MODE=test under NODE_ENV=production", () => {
      expect(() => selectAuthMode({ ...prod, AUTH_MODE: "test" })).toThrow(
        /production/,
      );
    });
  });

  describe("invalid values fail loudly", () => {
    it("rejects an unknown DATABASE_DRIVER", () => {
      expect(() => selectDatabaseDriver({ DATABASE_DRIVER: "sqlite" })).toThrow(
        /DATABASE_DRIVER/,
      );
    });

    it("rejects an unknown ARCA_ADAPTER", () => {
      expect(() => selectArcaAdapter({ ARCA_ADAPTER: "stub" })).toThrow(
        /ARCA_ADAPTER/,
      );
    });
  });

  describe("auth seam", () => {
    it("real mode DENIES without a session (fail-closed)", async () => {
      const guard = composeAuthGuard({ AUTH_MODE: "real" }, async () => null);
      await expect(guard()).rejects.toThrow(UnauthorizedError);
    });

    it("real mode ALLOWS with a session", async () => {
      const guard = composeAuthGuard(
        { AUTH_MODE: "real" },
        async () => ({ user: { email: "a@b.c" } }),
      );
      await expect(guard()).resolves.toBeUndefined();
    });

    it("test mode injects a stub session (no denial)", async () => {
      const guard = composeAuthGuard({ AUTH_MODE: "test" });
      await expect(guard()).resolves.toBeUndefined();
    });
  });
});
