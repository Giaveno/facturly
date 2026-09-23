import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { taCache } from "./schema";
import { DrizzleTaCacheStore } from "./ta-cache-store";
import type { Db } from "./types";

/**
 * The `ta_cache` table is the DB-backed persistence for the WSAA TA cache —
 * proving entries survive across `get`/`put` and that a `put` upserts (one row
 * per service, never duplicates).
 */
describe("DrizzleTaCacheStore (ta_cache table)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => {
    await close();
  });

  it("persists and reads back a TA entry", async () => {
    const store = new DrizzleTaCacheStore(db);
    await store.put("wsfe", {
      token: "token-a",
      sign: "sign-a",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });

    const entry = await store.get("wsfe");
    expect(entry).toEqual({
      token: "token-a",
      sign: "sign-a",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });
  });

  it("returns null for an unknown service", async () => {
    const store = new DrizzleTaCacheStore(db);
    expect(await store.get("ws_sr_constancia_inscripcion")).toBeNull();
  });

  it("upserts: a second put for the same service replaces, never duplicates", async () => {
    const store = new DrizzleTaCacheStore(db);
    await store.put("wsfe", {
      token: "token-v1",
      sign: "sign-v1",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });
    await store.put("wsfe", {
      token: "token-v2",
      sign: "sign-v2",
      expiresAt: 1_700_100_000_000,
      issuedAt: 1_699_100_000_000,
    });

    const entry = await store.get("wsfe");
    expect(entry?.token).toBe("token-v2");
    expect(entry?.sign).toBe("sign-v2");

    const rows = await db.select().from(taCache);
    expect(rows).toHaveLength(1);
  });

  it("keeps the two services as independent rows", async () => {
    const store = new DrizzleTaCacheStore(db);
    await store.put("wsfe", {
      token: "w-token",
      sign: "w-sign",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });
    await store.put("ws_sr_constancia_inscripcion", {
      token: "p-token",
      sign: "p-sign",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });

    expect((await store.get("wsfe"))?.token).toBe("w-token");
    expect((await store.get("ws_sr_constancia_inscripcion"))?.token).toBe(
      "p-token",
    );
  });

  it("deletes a cached entry (eviction)", async () => {
    const store = new DrizzleTaCacheStore(db);
    await store.put("wsfe", {
      token: "evict-me",
      sign: "sign",
      expiresAt: 1_700_000_000_000,
      issuedAt: 1_699_000_000_000,
    });
    await store.delete("wsfe");
    expect(await store.get("wsfe")).toBeNull();
  });
});
