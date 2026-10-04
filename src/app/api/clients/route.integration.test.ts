import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import type { Db } from "@/lib/db/types";
import { clients, delegations } from "@/lib/db/schema";

// Only the auth seam and the DB accessor are mocked. The REAL `createClient`
// runs against a real PGlite database, so this proves the route maps a GENUINE
// Drizzle-wrapped unique violation (code under `.cause`) to 409 — the flat
// `err.code === "23505"` check would have returned 500 here (W1).
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAccountantSession: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { requireAccountantSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { POST as clientsPOST } from "@/app/api/clients/route";

describe("clients route — REAL duplicate CUIT surfaces as 409 (not 500)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAccountantSession).mockImplementation(async () => {});
    vi.mocked(getDb).mockReturnValue(db as never);
    await db.delete(delegations);
    await db.delete(clients);
  });

  function req(body: unknown): Request {
    const headers = new Headers();
    headers.set("host", "app.example.com");
    return new Request("http://app.example.com/api/clients", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  }

  it("creates (201) then rejects a truly duplicate CUIT with 409 and no second row", async () => {
    const payload = {
      razonSocial: "DUP S.A.",
      cuit: "30710145764",
      ptoVta: 1,
      condicionIva: "ri",
    };

    const first = await clientsPOST(req(payload));
    expect(first.status).toBe(201);

    const second = await clientsPOST(req({ ...payload, razonSocial: "DUP2 S.A." }));
    expect(second.status).toBe(409);
    const body = await second.json();
    // The raw Postgres detail must not leak.
    expect(JSON.stringify(body)).not.toContain("duplicate");

    const rows = await db.select().from(clients).where(eq(clients.cuit, "30710145764"));
    expect(rows).toHaveLength(1);
  });
});
