import { describe, it, expect } from "vitest";
import { deriveAmounts } from "./amounts";

describe("deriveAmounts — integer-centavos IVA breakdown (never float)", () => {
  it("Factura A (1) itemizes 21% IVA: net + iva = total", () => {
    // 121000 centavos = $1210.00 → net $1000.00 (100000), iva $210.00 (21000).
    const r = deriveAmounts(121000, 1,21);
    expect(r).toEqual({ net: 100000, iva: 21000, total: 121000 });
    expect(Number.isInteger(r.net)).toBe(true);
    expect(Number.isInteger(r.iva)).toBe(true);
    expect(r.net + r.iva).toBe(r.total);
  });

  it("Factura A rounds the IVA to the nearest centavo (no drift)", () => {
    // $100.00 total = 10000 centavos → iva = round(10000*21/121) = 1736, net 8264.
    const r = deriveAmounts(10000, 1,21);
    expect(r.iva).toBe(1736);
    expect(r.net).toBe(8264);
    expect(r.net + r.iva).toBe(10000);
  });

  it("Factura B (6) still reports taxable net and IVA to WSFE", () => {
    const r = deriveAmounts(121000, 6,21);
    expect(r).toEqual({ net: 100000, iva: 21000, total: 121000 });
  });

  it("Factura C (11) does NOT itemize IVA: net = total, iva = 0", () => {
    const r = deriveAmounts(121000, 11);
    expect(r).toEqual({ net: 121000, iva: 0, total: 121000 });
  });

  it("rejects a non-integer or negative total", () => {
    expect(() => deriveAmounts(1.5, 1)).toThrow();
    expect(() => deriveAmounts(-1, 1)).toThrow();
  });

  it("is pure and deterministic (two calls give identical results)", () => {
    expect(deriveAmounts(999999, 1,21)).toEqual(deriveAmounts(999999, 1,21));
  });
});
