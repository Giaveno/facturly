import { describe, expect, it } from "vitest";
import { canAnnulComprobante, VerificationAction, KnownArcaCause } from "./comprobantes-list";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("comprobante annulment action eligibility", () => {
  it("shows the known cause and read-only verification only for uncertain rows", () => {
    const action = (estado: string) => renderToStaticMarkup(createElement(VerificationAction, { estado, disabled: false, verifying: false, onVerify() {} }));
    expect(action("incierto")).toContain("Verificar en ARCA");
    expect(action("aprobado")).toBe("");
    expect(action("rechazado")).toBe("");
    expect(renderToStaticMarkup(createElement(KnownArcaCause, { estado: "incierto", errores: "Tiempo de espera agotado" }))).toContain("Tiempo de espera agotado");
    expect(renderToStaticMarkup(createElement(VerificationAction, { estado: "incierto", disabled: true, verifying: true, onVerify() {} }))).toContain('disabled=""');
  });
  it.each([1, 6, 11])("allows approved invoice type %s with CAE", (cbteTipo) => {
    expect(canAnnulComprobante({ estado: "aprobado", cbteTipo, cae: "CAE" })).toBe(true);
  });
  it.each([3, 8, 13, 99])("hides the action for non-invoice type %s", (cbteTipo) => {
    expect(canAnnulComprobante({ estado: "aprobado", cbteTipo, cae: "CAE" })).toBe(false);
  });
  it("hides the action unless the invoice is approved and CAE-backed", () => {
    expect(canAnnulComprobante({ estado: "pendiente", cbteTipo: 1, cae: "CAE" })).toBe(false);
    expect(canAnnulComprobante({ estado: "aprobado", cbteTipo: 1, cae: null })).toBe(false);
  });
});
