import { describe, it, expect } from "vitest";
import { computeCuitCheckDigit, isValidCuit } from "./cuit";

describe("cuit — Mod-11 checksum", () => {
  it("computes the check digit for a known 10-digit prefix", () => {
    expect(computeCuitCheckDigit("3000000000")).toBe(7);
    expect(computeCuitCheckDigit("2012345678")).toBe(6);
    expect(computeCuitCheckDigit("3071014576")).toBe(4);
  });

  it("accepts valid CUITs (real-world examples)", () => {
    expect(isValidCuit("30000000007")).toBe(true); // official AFIP example
    expect(isValidCuit("30710145764")).toBe(true); // real invoice CUIT
    expect(isValidCuit("30717336905")).toBe(true); // real invoice CUIT
    expect(isValidCuit("20123456786")).toBe(true); // computed: check = 6
  });

  it("accepts hyphenated formatting", () => {
    expect(isValidCuit("30-00000000-7")).toBe(true);
    expect(isValidCuit("30-71014576-4")).toBe(true);
    expect(isValidCuit("20-12345678-6")).toBe(true);
  });

  it("rejects an invalid check digit", () => {
    expect(isValidCuit("30000000008")).toBe(false);
    expect(isValidCuit("30710145765")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidCuit("3000000000")).toBe(false); // 10 digits
    expect(isValidCuit("300000000007")).toBe(false); // 12 digits
    expect(isValidCuit("")).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(isValidCuit("30A00000007")).toBe(false);
    expect(isValidCuit("abcdefghijk")).toBe(false);
  });

  it("rejects an invalid type prefix", () => {
    // 99 is not a valid CUIT type prefix (20/23/24/25/26/27/30/33/34).
    expect(isValidCuit("99123456780")).toBe(false);
  });

  it("rejects a CUIT whose raw Mod-11 check would be 10 (remainder 1)", () => {
    // Base "2000000080" sums to remainder 1 → raw check digit 10, which is not
    // a single digit. ARCA renumbers the prefix (20→23) instead; a fabricated
    // trailing 9 must NOT validate. See Ley 27.618 / RG 5003 renumbering.
    expect(isValidCuit("20000000809")).toBe(false);
    expect(isValidCuit("20000000800")).toBe(false);
  });

  it("accepts the renumbered 23/33/34 prefixes", () => {
    // 20→23 renumber of "00000080" carries check digit 9.
    expect(isValidCuit("23000000809")).toBe(true);
    // Plain valid 33 and 34 prefix vectors.
    expect(isValidCuit("33000000006")).toBe(true);
    expect(isValidCuit("34000000002")).toBe(true);
  });

  it("handles a document number with leading zeros", () => {
    // Document number 00000017 — leading zeros must not break the checksum.
    expect(isValidCuit("20000000176")).toBe(true);
  });
});
