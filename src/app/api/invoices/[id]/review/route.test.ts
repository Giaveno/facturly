import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/review/workflow", () => ({
  InvoiceStateError: class InvoiceStateError extends Error {},
  markInvoiceReviewed: vi.fn(),
}));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { InvoiceStateError, markInvoiceReviewed } from "@/lib/review/workflow";
import { POST as reviewPOST } from "@/app/api/invoices/[id]/review/route";

const VALID_UUID = "00000000-0000-4000-8000-000000000000";

function req(init?: { origin?: string }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  return new Request("http://app.example.com/api/invoices", { method: "POST", headers });
}

describe("invoice review route — PENDING → REVIEWED confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
  });

  it("rejects a non-UUID [id] with 400 before auth or DB", async () => {
    const res = await reviewPOST(req(), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(400);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated with 401", async () => {
    const res = await reviewPOST(req(), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(401);
    expect(markInvoiceReviewed).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await reviewPOST(req({ origin: "https://evil.net" }), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(403);
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("returns the reviewed invoice state on success", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(markInvoiceReviewed).mockResolvedValue({ id: VALID_UUID, status: "REVIEWED" });

    const res = await reviewPOST(req(), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: VALID_UUID, status: "REVIEWED" });
  });

  it("returns an opaque 500 for a failed transition (never leaks internals)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(markInvoiceReviewed).mockRejectedValue(new Error("only PENDING invoices may be marked reviewed"));

    const res = await reviewPOST(req(), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("PENDING");
  });

  it("maps an InvoiceStateError (wrong state) to 409, not 500 (W8)", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(markInvoiceReviewed).mockRejectedValue(new InvoiceStateError(VALID_UUID, "REVIEWED", "review", "wrong state"));

    const res = await reviewPOST(req(), { params: Promise.resolve({ id: VALID_UUID }) });
    expect(res.status).toBe(409);
  });
});
