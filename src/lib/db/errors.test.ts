import { describe, it, expect } from "vitest";
import { classifyDbError } from "./errors";

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
