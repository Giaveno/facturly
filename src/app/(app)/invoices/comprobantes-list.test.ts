import { describe, expect, it } from "vitest";
import { canAnnulComprobante } from "./comprobantes-list";

describe("comprobante annulment action eligibility", () => {
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
