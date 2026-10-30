import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/invoices/read-model", () => ({ listIssuedInvoices: vi.fn(async () => []), countApprovedComprobantes: vi.fn(async () => 2) }));
vi.mock("@/lib/invoices/reconciliation", () => ({ listReservedAttempts: async () => [] }));
vi.mock("./reserved-attempts", () => ({ ReservedAttempts: () => null }));
vi.mock("./comprobantes-list", () => ({ default: () => null }));
import Page from "./page";
import { countApprovedComprobantes, listIssuedInvoices } from "@/lib/invoices/read-model";
describe("invoices approved count", () => {
  it("separates legacy records as historical read-only, never as new fiscal state", async () => {
    vi.mocked(listIssuedInvoices).mockResolvedValueOnce([{ invoiceId: "old", status: "EMITTED", razonSocial: "Histórico", cbteTipo: 11, cbteNro: 3, cae: "123", importeTotalCentavos: 100 }] as never);
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Históricos, solo lectura");
    expect(html).not.toContain("EMITTED");
    expect(html).toContain("No se importan ni se reenvían a ARCA");
  });
  it("counts modern approved comprobantes even when the legacy invoice list is empty", async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("2 comprobantes aprobados");
    expect(html).not.toContain("empty-state");
    expect(html).not.toContain("<table");
  });
  it("shows the empty state only when neither source contains issued invoices", async () => {
    vi.mocked(countApprovedComprobantes).mockResolvedValueOnce(0);
    expect(renderToStaticMarkup(await Page())).toContain("empty-state");
  });
});
