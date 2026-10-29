import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/session", async (original) => ({ ...(await original<typeof import("@/lib/auth/session")>()), requireAccountantSession: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/invoices/read-model", () => ({ loadApprovedComprobantePdfInput: vi.fn() }));
vi.mock("@/pdf/render", () => ({ buildComprobantePdfModel: vi.fn(), renderInvoicePdf: vi.fn() }));
import { requireAccountantSession } from "@/lib/auth/session";
import { loadApprovedComprobantePdfInput } from "@/lib/invoices/read-model";
import { renderInvoicePdf } from "@/pdf/render";
import { GET } from "./route";
const id = "00000000-0000-4000-8000-000000000000";
const companyA = "00000000-0000-4000-8000-000000000001";
const companyB = "00000000-0000-4000-8000-000000000002";
const req = (url = "http://app.test/api/comprobantes/" + id, headers?: HeadersInit) => new Request(url, { headers });
describe("comprobante PDF route", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(requireAccountantSession).mockResolvedValue(undefined); });
  it("refuses non-approved rows", async () => {
    vi.mocked(loadApprovedComprobantePdfInput).mockResolvedValue(null);
    const response = await GET(req(undefined, { "x-empresa-id": companyB }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(404);
    expect(renderInvoicePdf).not.toHaveBeenCalled();
  });
  it("requires a company scope", async () => {
    const response = await GET(req(), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(403);
    expect(loadApprovedComprobantePdfInput).not.toHaveBeenCalled();
  });
  it("denies a cross-company scoped request", async () => {
    vi.mocked(loadApprovedComprobantePdfInput).mockResolvedValue(null);
    const response = await GET(req(undefined, { "x-empresa-id": companyB }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(404);
    expect(loadApprovedComprobantePdfInput).toHaveBeenCalledWith(expect.anything(), id, companyB);
  });
});
