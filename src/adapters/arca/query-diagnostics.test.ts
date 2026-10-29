import { expect, it } from "vitest";
import { safeQueryDiagnostic } from "./query-diagnostics";

it("bounds and allowlists diagnostics at every trust boundary", () => {
  expect(safeQueryDiagnostic({ stage: "wsaa", category: "http", httpStatus: 503, providerCodes: [1, "SECRET", -1, 1.5, 1_000_000_000], raw: "PRIVATE" })).toEqual({ stage: "wsaa", category: "http", httpStatus: 503, providerCodes: [1] });
  expect(safeQueryDiagnostic({ stage: "wsfe", category: "soap-fault", httpStatus: "503", providerCodes: Array.from({ length: 20 }, (_, i) => i) })).toEqual({ stage: "wsfe", category: "soap-fault", providerCodes: Array.from({ length: 10 }, (_, i) => i) });
  expect(safeQueryDiagnostic({ stage: "padron", category: "provider-errors", providerCodes: [602, "SECRET"], message: "PRIVATE" })).toEqual({ stage: "padron", category: "provider-errors", providerCodes: [602] });
  for (const value of [null, [], "SECRET", { stage: "SECRET", category: "http" }, { stage: "wsfe", category: "SECRET" }]) expect(safeQueryDiagnostic(value)).toBeUndefined();
  for (const status of [NaN, Infinity, -1, 99, 600, 200.5]) expect(safeQueryDiagnostic({ stage: "wsfe", category: "http", httpStatus: status })).toEqual({ stage: "wsfe", category: "http" });
});
it("allows only fixed Padrón SOAP Fault reasons", () => {
  for (const faultReason of ["validation-rejected", "unclassified"]) expect(safeQueryDiagnostic({ stage: "padron", category: "soap-fault", faultReason })).toEqual({ stage: "padron", category: "soap-fault", faultReason });
  for (const patch of [{ faultReason: "SECRET" }, { faultReason: { message: "SECRET" } }, { faultReason: "validation-rejected", stage: "wsaa" }, { faultReason: "validation-rejected", category: "http" }]) {
    const value = { stage: "padron", category: "soap-fault", ...patch };
    expect(safeQueryDiagnostic(value)).toEqual({ stage: value.stage, category: value.category });
  }
});
