import { and, eq, isNull, lte } from "drizzle-orm";
import { emissionSeriesClaims } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
export const SERIES_LEASE_MS = 180_000;
export function seriesKey(environment: "production" | "produccion" | "homologacion", cuit: string, ptoVta: number, cbteTipo: number): string {
 // `comprobantes` stores the Spanish enum value, while legacy invoices use
 // the server-config value. Claims must be shared across both aggregates.
 const canonicalEnvironment = environment === "produccion" ? "production" : environment;
 return JSON.stringify([canonicalEnvironment,cuit,ptoVta,cbteTipo]);
}
/** Atomic compare-and-set, shared by every worker. Never steal even an expired claim. */
export async function acquireSeriesClaim(db: Db, key: string, owner: string, now = Date.now()): Promise<boolean> {
  const rows = await db.insert(emissionSeriesClaims).values({seriesKey:key,owner,leaseExpiresAtMs:now+SERIES_LEASE_MS,uncertain:false,uncertainSinceMs:null})
    .onConflictDoUpdate({target:emissionSeriesClaims.seriesKey,set:{owner,leaseExpiresAtMs:now+SERIES_LEASE_MS,uncertainSinceMs:null},where:and(isNull(emissionSeriesClaims.owner),eq(emissionSeriesClaims.uncertain,false))}).returning();
  return rows[0]?.owner === owner;
}
/** Recovery-only takeover of an expired or grace-elapsed observed generation. */
export async function acquireExpiredSeriesClaim(
  db: Db,
  observed: typeof emissionSeriesClaims.$inferSelect,
  owner: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db.update(emissionSeriesClaims).set({
    owner,
    leaseExpiresAtMs: now + SERIES_LEASE_MS,
    uncertain: false,
    uncertainSinceMs: null,
  }).where(and(
    eq(emissionSeriesClaims.seriesKey, observed.seriesKey),
    observed.owner === null ? isNull(emissionSeriesClaims.owner) : eq(emissionSeriesClaims.owner, observed.owner),
    eq(emissionSeriesClaims.leaseExpiresAtMs, observed.leaseExpiresAtMs),
    eq(emissionSeriesClaims.uncertain, observed.uncertain),
    lte(emissionSeriesClaims.leaseExpiresAtMs, now),
  )).returning();
  return rows[0]?.owner === owner;
}
export async function finishSeriesClaim(db: Db, key: string, owner: string, authorized: boolean, now = Date.now()): Promise<void> {
  await db.update(emissionSeriesClaims).set({owner:null,uncertain:!authorized,uncertainSinceMs:authorized ? null : now,leaseExpiresAtMs:now})
    .where(and(eq(emissionSeriesClaims.seriesKey,key),eq(emissionSeriesClaims.owner,owner)));
}
/** Recovery releases only the exact observed generation, never a subsequent dispatch. */
export async function reconcileSeriesClaim(db: Db, observed: typeof emissionSeriesClaims.$inferSelect): Promise<void> {
  await db.update(emissionSeriesClaims).set({owner:null,uncertain:false,uncertainSinceMs:null}).where(and(
    eq(emissionSeriesClaims.seriesKey,observed.seriesKey),
    observed.owner === null ? isNull(emissionSeriesClaims.owner) : eq(emissionSeriesClaims.owner,observed.owner),
    eq(emissionSeriesClaims.leaseExpiresAtMs,observed.leaseExpiresAtMs),
    eq(emissionSeriesClaims.uncertain,observed.uncertain),
  ));
}
/** Revalidate immediately before dispatch, so late work cannot outlive a recovered lease. */
export async function ownsSeriesClaim(db: Db, key: string, owner: string, clock: () => number = Date.now): Promise<boolean> {
  const [claim]=await db.select().from(emissionSeriesClaims).where(and(eq(emissionSeriesClaims.seriesKey,key),eq(emissionSeriesClaims.owner,owner)));
  const now = clock();
  return !!claim && !claim.uncertain && claim.leaseExpiresAtMs>now;
}
