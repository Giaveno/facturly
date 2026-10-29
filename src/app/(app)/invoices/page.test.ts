import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/invoices/read-model", () => ({ listIssuedInvoices: vi.fn(async () => []), countApprovedComprobantes: vi.fn(async () => 2) }));
vi.mock("@/lib/invoices/reconciliation", () => ({ listReservedAttempts: async () => [] }));
vi.mock("./reserved-attempts", () => ({ ReservedAttempts: () => null }));
vi.mock("./comprobantes-list", () => ({ default: () => null }));
import Page from "./page";
import { countApprovedComprobantes } from "@/lib/invoices/read-model";
describe("invoices approved count", () => {
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
