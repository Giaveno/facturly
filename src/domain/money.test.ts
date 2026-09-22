import { describe, it, expect } from "vitest";
import { parseToCentavos, formatCentavos, sumCentavos } from "./money";

describe("money — integer centavos only", () => {
  it("parses a decimal string to integer centavos without floating point", () => {
    expect(parseToCentavos("1234.56")).toBe(123456);
    expect(parseToCentavos("0.10")).toBe(10);
    expect(parseToCentavos("0.20")).toBe(20);
    expect(parseToCentavos("1")).toBe(100);
    expect(parseToCentavos("1.5")).toBe(150);
  });

  it("accumulates fractional amounts without float drift", () => {
    const a = parseToCentavos("0.10");
    const b = parseToCentavos("0.20");
    const sum = sumCentavos(a, b);
    expect(sum).toBe(30); // NOT 30.000000000000004
    expect(formatCentavos(sum)).toBe("0.30");
  });

  it("avoids the classic 0.1 + 0.2 float drift", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. Integer centavos must not drift.
    const cents = sumCentavos(parseToCentavos("0.1"), parseToCentavos("0.2"));
    expect(cents).toBe(30);
    expect(formatCentavos(cents)).toBe("0.30");
  });

  it("formats integer centavos back to a decimal string", () => {
    expect(formatCentavos(123456)).toBe("1234.56");
    expect(formatCentavos(30)).toBe("0.30");
    expect(formatCentavos(5)).toBe("0.05");
    expect(formatCentavos(0)).toBe("0.00");
  });

  it("rejects non-numeric input", () => {
    expect(() => parseToCentavos("abc")).toThrow();
    expect(() => parseToCentavos("1.2.3")).toThrow();
    expect(() => parseToCentavos("12.345")).toThrow(); // >2 decimals
    expect(() => parseToCentavos("-1.00")).toThrow(); // negative out of scope
  });

  it("rejects non-integer centavos in sumCentavos", () => {
    expect(() => sumCentavos(1.5)).toThrow();
  });

  it("rejects thousands separators (documented accepted format)", () => {
    // Accepted format is plain decimal "1234.56". Thousands separators and the
    // reversed comma/period convention are NOT accepted.
    expect(() => parseToCentavos("1.234,56")).toThrow();
    expect(() => parseToCentavos("1,234.56")).toThrow();
    expect(() => parseToCentavos("1 234.56")).toThrow();
  });

  it("rejects amounts whose centavos exceed the safe-integer range", () => {
    // 9007199254740991 is Number.MAX_SAFE_INTEGER (exact integer arithmetic).
    expect(parseToCentavos("90071992547409.91")).toBe(9007199254740991);
    // One cent more crosses into unsafe precision and must fail loudly.
    expect(() => parseToCentavos("90071992547409.92")).toThrow();
    expect(() => parseToCentavos("9007199254740992")).toThrow();
  });

  it("rejects negative amounts consistently across parse/sum/format", () => {
    // Credit notes are out of scope for v1 — negatives must be rejected
    // everywhere, not only in formatCentavos.
    expect(() => parseToCentavos("-1.00")).toThrow();
    expect(() => sumCentavos(-1)).toThrow();
    expect(() => sumCentavos(100, -1)).toThrow();
    expect(() => formatCentavos(-1)).toThrow();
  });

  it("rejects a sum whose accumulator exceeds the safe-integer range", () => {
    expect(sumCentavos(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => sumCentavos(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
});
