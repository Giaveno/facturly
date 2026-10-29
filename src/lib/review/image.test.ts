import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import type { Db } from "@/lib/db/types";
import { batches,clients,ocrRows,photos } from "@/lib/db/schema";
import { loadReceiptImage } from "./image";
import type { ReceiptStorage } from "@/ports/receipt-storage";
describe("private receipt resolution",()=>{
 let db:Db;let close:()=>Promise<void>;let batchId:string;
 const storage:ReceiptStorage={get:vi.fn(),put:vi.fn(),delete:vi.fn()};
 beforeAll(async()=>{({db,close}=await createTestDb());const[c]=await db.insert(clients).values({cuit:"20123456786",razonSocial:"Issuer",ptoVta:1,condicionIva:"ri"}).returning();const[b]=await db.insert(batches).values({clientId:c!.id}).returning();batchId=b!.id;});
 afterAll(async()=>{await close();});
 async function seed(storageKey:string){const[p]=await db.insert(photos).values({batchId,storageKey}).returning();const[r]=await db.insert(ocrRows).values({photoId:p!.id,fields:{name:"Payer",amount:1,date:"2026-10-28"},confidence:{}}).returning();return r!.id;}
 it("resolves only internally stored keys and sniffs MIME rather than trusting extension",async()=>{const key="00000000-0000-4000-8000-000000000000.png";const id=await seed(key);vi.mocked(storage.get).mockResolvedValue(new Uint8Array([255,216,255]));expect((await loadReceiptImage(db,id,storage))!.mime).toBe("image/jpeg");expect(storage.get).toHaveBeenLastCalledWith(key);});
 it.each(["../../secret","legacy.jpg","C:\\secret.png"])("refuses unsafe or legacy storage key %s",async key=>{vi.mocked(storage.get).mockClear();const id=await seed(key);expect(await loadReceiptImage(db,id,storage)).toBeNull();expect(storage.get).not.toHaveBeenCalled();});
 it("returns no preview for missing rows, missing bytes or unsupported bytes",async()=>{expect(await loadReceiptImage(db,"00000000-0000-4000-8000-000000000000",storage)).toBeNull();const id=await seed("00000000-0000-4000-8000-000000000001.jpg");vi.mocked(storage.get).mockRejectedValue(new Error("missing"));expect(await loadReceiptImage(db,id,storage)).toBeNull();vi.mocked(storage.get).mockResolvedValue(new Uint8Array([60,115,99,114,105,112,116]));expect(await loadReceiptImage(db,id,storage)).toBeNull();});
});
