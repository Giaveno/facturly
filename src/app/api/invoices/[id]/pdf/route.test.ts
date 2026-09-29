import { beforeEach, describe, expect, it, vi } from "vitest";

// Thin route over already-tested services; mock the dependencies to prove the
// route-level behaviours: W5 (UUID → 400), auth seam (→ 401), no-CAE (→ 404),
// and the happy path (→ 200 application/pdf bytes).
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/invoices/read-model", () => ({
  loadIssuedInvoicePdfInput: vi.fn(),
}));
vi.mock("@/pdf/render", () => ({
  buildInvoicePdfModel: vi.fn(),
  renderInvoicePdf: vi.fn(),
}));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { loadIssuedInvoicePdfInput } from "@/lib/invoices/read-model";
import { buildInvoicePdfModel, renderInvoicePdf } from "@/pdf/render";
import { GET as pdfGET } from "@/app/api/invoices/[id]/pdf/route";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(): Request {
  return new Request("http://test/api");
}

describe("invoice PDF route — W5, auth, no-CAE, happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fail-closed default: the auth seam denies.
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
    vi.mocked(getDb).mockReturnValue({} as never);
  });

  it("400 for a non-UUID id, before auth or DB", async () => {
    const res = await pdfGET(request(), params("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid invoice id");
    expect(requireAccountantSession).not.toHaveBeenCalled();
    expect(loadIssuedInvoicePdfInput).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated", async () => {
    const res = await pdfGET(request(), params(VALID_UUID));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("404 (opaque) when the invoice has no CAE", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(loadIssuedInvoicePdfInput).mockResolvedValue(null);

    const res = await pdfGET(request(), params(VALID_UUID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Invoice not found or not issued");
    expect(renderInvoicePdf).not.toHaveBeenCalled();
  });

  it("200 with application/pdf bytes for a valid issued invoice", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(loadIssuedInvoicePdfInput).mockResolvedValue({
      cuit: "20123456789",
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 1,
      cae: "70000000000001",
      caeFchVto: "2026-10-02",
      fechaEmision: "2026-09-22",
      importeTotal: 121000,
      moneda: "PES",
      receptorDocTipo: 80,
      receptorDocNro: 20123456786,
      condicionIvaReceptorId: 6,
      receptorRazonSocial: "ACME S.A.",
    });
    vi.mocked(buildInvoicePdfModel).mockReturnValue({
      qrUrl: "https://example/qr",
      lines: [],
      includesLey27618Legend: false,
    });
    vi.mocked(renderInvoicePdf).mockResolvedValue(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );

    const res = await pdfGET(request(), params(VALID_UUID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("invoice-1.pdf");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  });
});
