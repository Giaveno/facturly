import { describe, expect, it } from "vitest";
import {
  ComprobanteValidationError,
  validateComprobante,
  type ComprobanteValidationInput,
} from "./comprobantes";

const item = {
  descripcion: "Servicio",
  netoCentavos: 10_000,
  ivaCentavos: 2_100,
  exentoCentavos: 0,
  tributosCentavos: 0,
  totalCentavos: 12_100,
  alicuota: 21 as const,
};

const base: ComprobanteValidationInput = {
  emisorCondicionIva: "ri",
  cbteTipo: 1,
  ptoVta: 1,
  concepto: 1,
  docTipo: 80,
  docNro: "30710145764",
  condicionIvaReceptor: 1,
  fecha: "2026-10-28",
  importeNetoCentavos: 10_000,
  importeIvaCentavos: 2_100,
  importeExentoCentavos: 0,
  importeTributosCentavos: 0,
  importeTotalCentavos: 12_100,
  items: [item],
};

const rejects = (change: Partial<ComprobanteValidationInput>, message: RegExp) => {
  expect(() => validateComprobante({ ...base, ...change })).toThrow(message);
};

describe("pre-emission comprobante validation", () => {
  it("accepts RI A/B and monotributo/exento C, and rejects cross-condition types", () => {
    for (const cbteTipo of [1, 6]) expect(validateComprobante({ ...base, cbteTipo }).cbteTipo).toBe(cbteTipo);
    for (const emisorCondicionIva of ["monotributista", "exento"] as const) {
      const cItem = { ...item, ivaCentavos: 0, totalCentavos: 10_000, alicuota: 0 as const };
      const value = validateComprobante({ ...base, emisorCondicionIva, cbteTipo: 11, importeIvaCentavos: 0, importeTotalCentavos: 10_000, items: [cItem] });
      expect(value.cbteTipo).toBe(11);
      rejects({ emisorCondicionIva, cbteTipo: 1 }, /solo puede emitir comprobantes C/);
    }
    rejects({ cbteTipo: 11 }, /solo puede emitir comprobantes A o B/);
  });

  it("enforces exact centavo arithmetic at document and item level", () => {
    rejects({ importeTotalCentavos: 12_101 }, /importe total/);
    rejects({ items: [{ ...item, totalCentavos: 12_101 }] }, /Ítem 1: total incoherente/);
    rejects({ items: [{ ...item, ivaCentavos: 2_000 }] }, /IVA incoherente/);
    rejects({ items: [{ ...item, totalCentavos: 12_100 }], importeNetoCentavos: 9_999 }, /suma de los ítems/);
  });

  it("accepts the complete receptor IVA catalog and validates documents", () => {
    for (const condicionIvaReceptor of [1, 4, 5, 6]) {
      expect(validateComprobante({ ...base, condicionIvaReceptor }).condicionIvaReceptor).toBe(condicionIvaReceptor);
    }
    expect(validateComprobante({ ...base, docTipo: 99, docNro: "0", condicionIvaReceptor: 5 }).docNro).toBe("0");
    rejects({ condicionIvaReceptor: 2 }, /CondicionIVAReceptorId/);
    rejects({ docTipo: 99, docNro: "123" }, /DocNro debe ser 0/);
    rejects({ docTipo: 80, docNro: "123" }, /CUIT\/CUIL/);
    rejects({ docTipo: 96, docNro: "123" }, /DNI/);
    rejects({ docTipo: 99, docNro: "0", condicionIvaReceptor: 1 }, /DocTipo 99 requiere/);
  });

  it("bounds an assigned comprobante number", () => {
    expect(validateComprobante({ ...base, cbteNro: 9_999_999 }).cbteNro).toBe(9_999_999);
    rejects({ cbteNro: 10_000_000 }, /CbteNro/);
    rejects({ cbteNro: 0 }, /CbteNro/);
  });

  it("sanitizes ARCA observations and errors before returning them", () => {
    const value = validateComprobante({ ...base, observaciones: "  ARCA\u0000\u0007  rechazó\n  ", errores: "\u001b[31m10049\u001b[0m" });
    expect(value.observaciones).toBe("ARCA rechazó");
    expect(value.errores).toBe("[31m10049 [0m");
  });

  it("does not expose a gateway side effect and reports all failures together", () => {
    try {
      validateComprobante({ ...base, cbteTipo: 11, importeTotalCentavos: 1, items: [] });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ComprobanteValidationError);
      expect((error as ComprobanteValidationError).issues.length).toBeGreaterThan(1);
    }
  });

  it("turns malformed runtime payloads into validation errors instead of TypeError/RangeError", () => {
    expect(() => validateComprobante(null as never)).toThrow(ComprobanteValidationError);
    expect(() => validateComprobante({ ...base, items: null as never })).toThrow(ComprobanteValidationError);
    expect(() => validateComprobante({ ...base, items: [null] as never })).toThrow(ComprobanteValidationError);
    expect(() => validateComprobante({ ...base, items: [{ ...item, alicuota: undefined }] as never })).toThrow(ComprobanteValidationError);
    expect(() => validateComprobante({ ...base, observaciones: 42 as never })).toThrow(ComprobanteValidationError);
    expect(() => validateComprobante({ ...base, errores: {} as never })).toThrow(ComprobanteValidationError);
  });
});
