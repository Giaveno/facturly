/**
 * Drizzle-backed TA cache store — persists WSAA tickets in the `ta_cache` table
 * so they survive serverless cold starts (process memory does not).
 */

import { eq } from "drizzle-orm";
import { taCache } from "./schema";
import type { Db } from "./types";
import type { TaCacheEntry, TaCacheStore } from "@/adapters/arca/ta-cache";

/** Drizzle `ta_cache` implementation of the cache-store port. */
export class DrizzleTaCacheStore implements TaCacheStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async get(service: string): Promise<TaCacheEntry | null> {
    const row = await this.db.query.taCache.findFirst({
      where: eq(taCache.service, service),
    });
    if (!row) return null;
    return {
      token: row.token,
      sign: row.sign,
      expiresAt: row.expiresAtMs,
      issuedAt: row.issuedAtMs,
    };
  }

  async put(service: string, entry: TaCacheEntry): Promise<void> {
    await this.db
      .insert(taCache)
      .values({
        service,
        token: entry.token,
        sign: entry.sign,
        expiresAtMs: entry.expiresAt,
        issuedAtMs: entry.issuedAt,
      })
      .onConflictDoUpdate({
        target: taCache.service,
        set: {
          token: entry.token,
          sign: entry.sign,
          expiresAtMs: entry.expiresAt,
          issuedAtMs: entry.issuedAt,
        },
      });
  }

  async delete(service: string): Promise<void> {
    await this.db.delete(taCache).where(eq(taCache.service, service));
  }
}
