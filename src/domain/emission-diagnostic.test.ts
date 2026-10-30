import { describe, it, expect } from "vitest";
import { comprobanteStatusLabel } from "./emission-diagnostic";
describe("canonical fiscal outcome labels", () => {
  it.each(["L", "N", null])("labels non-issuance instead of rejection (%s)", resultado => {
    expect(comprobanteStatusLabel({ estado: "rechazado", resultado })).toBe("No emitido");
  });
  it("reserves Rechazado for actual ARCA rejection", () => {
    expect(comprobanteStatusLabel({ estado: "rechazado", resultado: "R", errores: "Rechazo ARCA (10016)" })).toBe("Rechazado");
  });
  it("does not reinterpret a genuine rejection quoting part of the old reason", () => {
    expect(comprobanteStatusLabel({ estado: "rechazado", resultado: "R", errores: "Rechazo ARCA: ARCA no encontró el comprobante reservado en validación" })).toBe("Rechazado");
  });
  it("recognizes historical not-found rows even though they stored R", () => {
    const cause = "ARCA no encontró el comprobante reservado; no se reemitirá automáticamente.";
    for (const errores of [cause, JSON.stringify({ phase: "reconciliation", cause })]) {
      expect(comprobanteStatusLabel({ estado: "rechazado", resultado: "R", errores })).toBe("No emitido");
    }
  });
});
