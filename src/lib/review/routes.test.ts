import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes are thin handlers over already-tested services; here we mock their
// dependencies to prove the route-level behaviors: W5 (UUID → 400), C6 (auth
// seam → 401), W4 (opaque 500), and C4 (approve sends the emit event).
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/emission/gateway", () => ({ buildArcaGateway: vi.fn() }));
vi.mock("@/lib/review/workflow", () => ({
  approveInvoice: vi.fn(),
  rejectInvoice: vi.fn(),
  InvoiceStateError: class InvoiceStateError extends Error {},
  DiscardReasonError: class DiscardReasonError extends Error {},
}));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { buildArcaGateway } from "@/lib/emission/gateway";
import {
  approveInvoice,
  DiscardReasonError,
  InvoiceStateError,
  rejectInvoice,
} from "@/lib/review/workflow";
import { inngest } from "@/lib/inngest/client";
import { POST as approvePOST } from "@/app/api/invoices/[id]/approve/route";
import { POST as rejectPOST } from "@/app/api/invoices/[id]/reject/route";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function req(body?: string, init?: { origin?: string }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  return new Request("http://app.example.com/api", {
    method: "POST",
    body:body ?? JSON.stringify({expected:{recipientMode:"identified",taxRate:21,issuerCondition:"ri",rowId:VALID_UUID,name:"Payer",cuit:"30710145764",date:"2026-10-28",amount:100,issuerCuit:"20123456786",issuerName:"Issuer",ptoVta:1,environment:"homologacion"}}),
    headers,
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("invoice approve/reject routes — W5, C6, W4, C4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fail-closed default: the auth seam denies.
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
    // No DATABASE_URL in tests → getDb throws, simulating a DB failure.
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("DATABASE_URL is not set — cannot connect to Neon");
    });
  });

  it("W5: approve rejects a non-UUID [id] with 400 before auth or DB", async () => {
    const res = await approvePOST(req(), params("not-a-uuid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid invoice id");
    expect(typeof body.correlationId).toBe("string");
    expect(requireAccountantSession).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("W5: reject rejects a non-UUID [id] with 400 before auth or DB", async () => {
    const res = await rejectPOST(req(), params("nope"));
    expect(res.status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("C6: approve rejects with 401 when the auth seam denies", async () => {
    const res = await approvePOST(req(), params(VALID_UUID));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
  });

  it("W2: approve rejects a cross-origin request with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await approvePOST(
      req(undefined, { origin: "https://evil.example.net" }),
      params(VALID_UUID),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Cross-origin request rejected");
    expect(requireAccountantSession).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("W2: a same-origin approve passes the origin gate (reaches auth)", async () => {
    const res = await approvePOST(
      req(undefined, { origin: "https://app.example.com" }),
      params(VALID_UUID),
    );
    // NOT 403 — the origin gate passed; the next gate (auth) denied → 401.
    expect(res.status).toBe(401);
    expect(requireAccountantSession).toHaveBeenCalledTimes(1);
  });

  it("W2: reject rejects a cross-origin request with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await rejectPOST(
      req(JSON.stringify({ reason: "non-sale" }), {
        origin: "https://evil.example.net",
      }),
      params(VALID_UUID),
    );
    expect(res.status).toBe(403);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("C6: reject rejects with 401 when the auth seam denies", async () => {
    const res = await rejectPOST(req(), params(VALID_UUID));
    expect(res.status).toBe(401);
  });

  it("W4: approve returns an opaque 500 and never leaks internal error text", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await approvePOST(req(), params(VALID_UUID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Approval failed");
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
    expect(typeof body.correlationId).toBe("string");
  });

  it("W4: reject returns an opaque 500 and never leaks internal error text", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await rejectPOST(
      req(JSON.stringify({ reason: "non-sale" })),
      params(VALID_UUID),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Rejection failed");
    expect(typeof body.correlationId).toBe("string");
  });

  it("C4: a successful approve sends the emit event with idempotencyKey = invoice id", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(buildArcaGateway).mockReturnValue({} as never);
    vi.mocked(approveInvoice).mockResolvedValue({
      id: VALID_UUID,
      status: "APPROVED",
    } as never);

    const res = await approvePOST(req(), params(VALID_UUID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: VALID_UUID, status: "APPROVED" });
    expect(approveInvoice).toHaveBeenCalledWith({}, {}, VALID_UUID, undefined, expect.objectContaining({amount:100,name:"Payer",issuerName:"Issuer"}), "homologacion");

    expect(inngest.send).toHaveBeenCalledWith({
      name: "emit/batch.requested",
      data: { invoiceIds: [VALID_UUID], idempotencyKey: VALID_UUID },
    });
  });

  it("C4: a successful reject does NOT emit", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(rejectInvoice).mockResolvedValue({
      id: VALID_UUID,
      status: "REJECTED",
      discardReason: "non-sale",
    } as never);

    const res = await rejectPOST(
      req(JSON.stringify({ reason: "non-sale" })),
      params(VALID_UUID),
    );
    expect(res.status).toBe(200);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("approve maps an InvoiceStateError (wrong state) to 409, not 500 (W8)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(buildArcaGateway).mockReturnValue({} as never);
    vi.mocked(approveInvoice).mockRejectedValue(new InvoiceStateError(VALID_UUID, "REVIEWED", "approve", "wrong state"));

    const res = await approvePOST(req(), params(VALID_UUID));
    expect(res.status).toBe(409);
  });

  it("reject maps an InvoiceStateError (wrong state) to 409, not 500 (W8)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(rejectInvoice).mockRejectedValue(new InvoiceStateError(VALID_UUID, "APPROVED", "reject", "wrong state"));

    const res = await rejectPOST(req(JSON.stringify({ reason: "x" })), params(VALID_UUID));
    expect(res.status).toBe(409);
  });

  it("reject maps a DiscardReasonError (empty/too-long reason) to 400, not 500 (W8)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(rejectInvoice).mockRejectedValue(new DiscardReasonError("a discard reason is required"));

    const res = await rejectPOST(req(JSON.stringify({ reason: "" })), params(VALID_UUID));
    expect(res.status).toBe(400);
  });
  it("approval requires the displayed snapshot before touching DB or gateway",async()=>{
    vi.mocked(requireAccountantSession).mockResolvedValue();
    const res=await approvePOST(req("{}"),params(VALID_UUID));
    expect(res.status).toBe(400);expect(getDb).not.toHaveBeenCalled();expect(buildArcaGateway).not.toHaveBeenCalled();expect(inngest.send).not.toHaveBeenCalled();
  });

});
