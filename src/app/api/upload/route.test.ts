import { beforeEach, describe, expect, it, vi } from "vitest";

// Thin route over already-tested services. We mock the session seam, DB, ingest
// and Inngest; the same-origin (CSRF) check and the upload guard run for real so
// the route-level security behaviours (401 unauth, 403 cross-origin) are proven.
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/pipeline/ingest", () => ({ queueUpload: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
const storagePut = vi.fn();
const storageDelete = vi.fn();
vi.mock("@/adapters/storage/local-receipt-storage", () => ({
  LocalReceiptStorage: class { put = storagePut; delete = storageDelete; get = vi.fn(); },
}));

import {
  requireAccountantSession,
  UnauthorizedError,
} from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { queueUpload } from "@/lib/pipeline/ingest";
import { inngest } from "@/lib/inngest/client";
import { POST as uploadPOST } from "@/app/api/upload/route";

function request(init?: { origin?: string; contentLength?: number }): Request {
  const headers = new Headers();
  headers.set("host", "app.example.com");
  if (init?.origin) headers.set("origin", init.origin);
  if (init?.contentLength !== undefined) {
    headers.set("content-length", String(init.contentLength));
  }
  return new Request("http://app.example.com/api/upload", {
    method: "POST",
    headers,
  });
}

describe("upload route — server-side auth (W1) + same-origin (W2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {
      throw new UnauthorizedError();
    });
  });

  it("W1: an unauthenticated upload gets 401 (no OCR cost, no rows)", async () => {
    const res = await uploadPOST(request());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Authentication required");
    expect(getDb).not.toHaveBeenCalled();
    expect(queueUpload).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("W2: a cross-origin upload is rejected with 403 BEFORE auth", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    const res = await uploadPOST(
      request({ origin: "https://evil.example.net" }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Cross-origin request rejected");
    // The origin check runs first: auth must never be reached.
    expect(requireAccountantSession).not.toHaveBeenCalled();
  });

  it("W2: a same-origin upload passes the origin gate (reaches auth → 401)", async () => {
    const res = await uploadPOST(
      request({ origin: "https://app.example.com" }),
    );
    // NOT 403 — the origin gate passed; the next gate (auth) denied.
    expect(res.status).toBe(401);
    expect(requireAccountantSession).toHaveBeenCalledTimes(1);
  });

  it("preserves committed rows and files when event dispatch fails", async () => {
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(queueUpload).mockResolvedValue({
      batchId: "batch-1", clientId: "550e8400-e29b-41d4-a716-446655440000",
      rows: [{ id: "row-1", status: "PENDING", cuit: null }, { id: "row-2", status: "PENDING", cuit: null }],
    });
    vi.mocked(inngest.send).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error("private path"));
    const form = new FormData();
    form.set("clientId", "550e8400-e29b-41d4-a716-446655440000");
    form.append("photos", new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], "receipt.jpg", { type: "image/jpeg" }));
    form.append("photos", new File([new Uint8Array([0xff, 0xd8, 0xff, 2])], "receipt-2.jpg", { type: "image/jpeg" }));
    const req = new Request("http://app.example.com/api/upload", { method: "POST", headers: { host: "app.example.com" }, body: form });

    const res = await uploadPOST(req);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/saved/i);
    expect(storageDelete).not.toHaveBeenCalled();
    expect(queueUpload).toHaveBeenCalledTimes(1);
  });
});
