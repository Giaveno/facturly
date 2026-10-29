import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { acquireSeriesClaim, finishSeriesClaim, seriesKey } from "./series-claim";
let handle: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { handle = await createTestDb(); });
afterAll(async () => { await handle.close(); });
it("serializes across independent allocators/process owners and isolates environments", async () => {
 const key = seriesKey("homologacion", "20123456786", 1, 11);
 const first = await acquireSeriesClaim(handle.db, key, "owner-a", 1000);
 expect(first).toBe(true);
 expect(await acquireSeriesClaim(handle.db, key, "owner-b", 1001)).toBe(false);
 expect(await acquireSeriesClaim(handle.db, seriesKey("production", "20123456786",1,11), "owner-b",1001)).toBe(true);
 await finishSeriesClaim(handle.db,key,"owner-a",false);
 // Uncertainty never expires into permission to emit. Restart must consult first.
 expect(await acquireSeriesClaim(handle.db,key,"owner-c",999999999)).toBe(false);
});
it("only the owner can release a successful claim; expired claims are not stolen", async () => {
 const key = seriesKey("homologacion", "20123456786", 2, 11);
 expect(await acquireSeriesClaim(handle.db,key,"owner-a",1000)).toBe(true);
 expect(await acquireSeriesClaim(handle.db,key,"owner-b",999999999)).toBe(false);
 await finishSeriesClaim(handle.db,key,"owner-b",true);
 expect(await acquireSeriesClaim(handle.db,key,"owner-c",999999999)).toBe(false);
 await finishSeriesClaim(handle.db,key,"owner-a",true);
 expect(await acquireSeriesClaim(handle.db,key,"owner-c",999999999)).toBe(true);
});
import { reconcileSeriesClaim } from "./series-claim";
it("stale recovery cannot clear a newly acquired dispatch owner", async () => {
 const key = seriesKey("homologacion","20123456786",3,11);
 await acquireSeriesClaim(handle.db,key,"old",1000);
 await finishSeriesClaim(handle.db,key,"old",false);
 const { emissionSeriesClaims } = await import("@/lib/db/schema");
 const { eq } = await import("drizzle-orm");
 const [observed] = await handle.db.select().from(emissionSeriesClaims).where(eq(emissionSeriesClaims.seriesKey,key));
 await reconcileSeriesClaim(handle.db,observed!);
 expect(await acquireSeriesClaim(handle.db,key,"new",2000)).toBe(true);
 await reconcileSeriesClaim(handle.db,observed!);
 expect(await acquireSeriesClaim(handle.db,key,"third",3000)).toBe(false);
});
import { ownsSeriesClaim } from "./series-claim";
it("dispatch requires current ownership and an unexpired lease",async()=>{
 const key=seriesKey("homologacion","20123456786",4,11);
 await acquireSeriesClaim(handle.db,key,"current",1000);
 expect(await ownsSeriesClaim(handle.db,key,"current",()=>1001)).toBe(true);
 expect(await ownsSeriesClaim(handle.db,key,"other",()=>1001)).toBe(false);
 expect(await ownsSeriesClaim(handle.db,key,"current",()=>999999999)).toBe(false);
});
import type { Db } from "@/lib/db/types";
it("reads lease time after a delayed ownership SELECT, not before it",async()=>{
 let now=1000;
 const events:string[]=[];
 const clock=vi.fn(()=>{events.push("clock");return now;});
 const delayed={select:()=>({from:()=>({where:async()=>{events.push("selected");now=500000;return [{owner:"owner",leaseExpiresAtMs:2000,uncertain:false}];}})})} as unknown as Db;
 expect(await ownsSeriesClaim(delayed,"key","owner",clock)).toBe(false);
 expect(events).toEqual(["selected","clock"]);
 expect(clock).toHaveBeenCalledOnce();
});
