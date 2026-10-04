import { describe, it, expect } from "vitest";
import { classifyDbError, isUniqueViolation } from "./errors";

describe("classifyDbError — client vs server status mapping", () => {
  it("maps a foreign-key violation (23503) to 400 (unknown client)", () => {
    expect(classifyDbError({ code: "23503" })).toBe(400);
  });

  it("maps an invalid text representation (22P02, bad UUID) to 400", () => {
    expect(classifyDbError({ code: "22P02" })).toBe(400);
  });

  it("maps anything else to 500", () => {
    expect(classifyDbError(new Error("boom"))).toBe(500);
    expect(classifyDbError(undefined)).toBe(500);
    expect(classifyDbError(null)).toBe(500);
  });
});

describe("isUniqueViolation — walks the Drizzle .cause chain", () => {
  it("recognizes a flat 23505 code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("recognizes a DrizzleQueryError wrapping the driver error under .cause", () => {
    const err = Object.assign(
      new Error("DrizzleQueryError: select ..."),
      { cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }) },
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("recognizes a deeper .cause chain (driver → socket)", () => {
    const err = {
      message: "failed",
      cause: {
        message: "insert failed",
        cause: { message: "duplicate key value", code: "23505" },
      },
    };
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("returns false for a non-unique error", () => {
    expect(isUniqueViolation(new Error("connection refused"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
