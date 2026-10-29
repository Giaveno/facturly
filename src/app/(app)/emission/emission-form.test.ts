import { describe, expect, it } from "vitest";
import { interpretEmissionResponse } from "./emission-form";

describe("interpretEmissionResponse", () => {
  it("only treats aprobado as success", () => {
    expect(interpretEmissionResponse({ estado: "aprobado", cae: "123" })).toMatchObject({ kind: "success", retryAllowed: true });
    expect(interpretEmissionResponse({ estado: "rechazado", errores: "100: CUIT inválido" })).toMatchObject({ kind: "rejected", retryAllowed: true, text: "100: CUIT inválido" });
  });
  it("preserves the key and blocks blind retries for incierto", () => {
    expect(interpretEmissionResponse({ estado: "incierto", errores: "Resultado incierto" })).toMatchObject({ kind: "blocked", retryAllowed: false });
    expect(interpretEmissionResponse({ code: "SERIES_BLOCKED", message: "serie bloqueada" })).toMatchObject({ kind: "blocked", retryAllowed: false });
  });

  it("distinguishes configuration-disabled emission from ARCA rejection", () => {
    expect(interpretEmissionResponse({ code: "EMISSIONS_DISABLED", error: "internal" })).toEqual({ kind: "disabled", text: "La emisión está deshabilitada en este servidor (configuración)", retryAllowed: false });
    expect(interpretEmissionResponse({ code: "10049", message: "ARCA rejected emission" })).toMatchObject({ kind: "rejected", retryAllowed: true, text: "10049: ARCA rejected emission" });
  });
});
