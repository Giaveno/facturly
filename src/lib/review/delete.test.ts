import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDb } from "@/test-support/test-db";
import { auditLog, batches, clients, invoices, issuedInvoices, ocrRows, photos, receiptCleanup } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { deleteReceiptRow, retryReceiptCleanup, ReceiptDeletionStateError } from "./delete";
import { processOcrRow } from "@/lib/ocr/process";
import { approveInvoice, markInvoiceReviewed, materializeInvoice } from "./workflow";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { OcrFake } from "@/adapters/ocr/ocr.fake";

describe("permanent receipt deletion", () => {
 let db: Db; let close: () => Promise<void>; let clientId: string;
 const storage = { put: vi.fn(), get: vi.fn(), delete: vi.fn(async (key: string) => { void key; }) };
 beforeAll(async () => { ({db, close} = await createTestDb()); const [c] = await db.insert(clients).values({cuit:"20123456786",razonSocial:"Issuer",ptoVta:1,condicionIva:"ri"}).returning(); clientId=c!.id; });
 afterAll(async () => { await close(); });
 async function seed(status?: typeof invoices.$inferInsert.status, key: string=randomUUID()) {
  const [batch]=await db.insert(batches).values({clientId}).returning();
  const [photo]=await db.insert(photos).values({batchId:batch!.id,storageKey:key}).returning();
  const [row]=await db.insert(ocrRows).values({photoId:photo!.id,fields:{name:"Private content",date:"",amount:0},confidence:{},status:"PENDING"}).returning();
  const invoice=status?(await db.insert(invoices).values({ocrRowId:row!.id,clientId,status}).returning())[0]:undefined;
  return {row:row!,photo:photo!,batch:batch!,invoice};
 }
 it.each([undefined,"PENDING","REVIEWED","REJECTED"] as const)("deletes %s and unreferenced photo/batch/file, preserves client and audit",async status=>{
  const s=await seed(status);
  await db.insert(auditLog).values({actor:"accountant",action:"old.action",rowId:s.row.id,invoiceId:s.invoice?.id,payload:{changedFields:["name"]}});
  storage.delete.mockClear();
  expect((await deleteReceiptRow(db,storage,s.row.id)).cleanup).toBe("complete");
  expect(await db.select().from(ocrRows).where(eq(ocrRows.id,s.row.id))).toHaveLength(0);
  expect(await db.select().from(photos).where(eq(photos.id,s.photo.id))).toHaveLength(0);
  expect(await db.select().from(batches).where(eq(batches.id,s.batch.id))).toHaveLength(0);
  expect(storage.delete).toHaveBeenCalledWith(s.photo.storageKey);
  const audits=await db.select().from(auditLog);const old=audits.find(a=>(a.payload as {deletedRowId?:string})?.deletedRowId===s.row.id && a.action==="old.action");
  expect(old).toMatchObject({rowId:null,invoiceId:null});
  const deleted=audits.find(a=>a.action==="row.deleted"&&(a.payload as {rowId?:string})?.rowId===s.row.id);
  expect(deleted).toMatchObject({rowId:null,invoiceId:null});expect(JSON.stringify(deleted)).not.toContain("Private content");
  expect(await db.select().from(clients).where(eq(clients.id,clientId))).toHaveLength(1);
 });
 it.each(["APPROVED","EMITTING","EMITTED","EMIT_ERROR","EMIT_FAILED"] as const)("blocks every fiscal state %s even when a deletable invoice comes first",async status=>{
  const s=await seed("PENDING");await db.insert(invoices).values({ocrRowId:s.row.id,clientId,status});storage.delete.mockClear();
  await expect(deleteReceiptRow(db,storage,s.row.id)).rejects.toBeInstanceOf(ReceiptDeletionStateError);
  expect(await db.select().from(ocrRows).where(eq(ocrRows.id,s.row.id))).toHaveLength(1);expect(storage.delete).not.toHaveBeenCalled();
 });
 it("blocks any issued reservation without CAE and leaves it intact",async()=>{
  const s=await seed("PENDING");await db.insert(issuedInvoices).values({invoiceId:s.invoice!.id,cuit:"20123456786",ptoVta:1,cbteTipo:11,cbteNro:1,importeTotalCentavos:100});
  await expect(deleteReceiptRow(db,storage,s.row.id)).rejects.toBeInstanceOf(ReceiptDeletionStateError);
  expect(await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId,s.invoice!.id))).toHaveLength(1);
 });
 it("retains a shared photo and only removes it after its final OCR row",async()=>{
  const s=await seed();const [other]=await db.insert(ocrRows).values({photoId:s.photo.id,fields:{name:"",date:"",amount:0},confidence:{}}).returning();storage.delete.mockClear();
  await deleteReceiptRow(db,storage,s.row.id);expect(storage.delete).not.toHaveBeenCalled();
  expect(await db.select().from(photos).where(eq(photos.id,s.photo.id))).toHaveLength(1);
  await deleteReceiptRow(db,storage,other!.id);expect(storage.delete).toHaveBeenCalledOnce();
 });
 it("retains a key used by another photo, removes only after final reference",async()=>{
  const s=await seed();const t=await seed(undefined,s.photo.storageKey);storage.delete.mockClear();
  await deleteReceiptRow(db,storage,s.row.id);expect(storage.delete).not.toHaveBeenCalled();
  await deleteReceiptRow(db,storage,t.row.id);expect(storage.delete).toHaveBeenCalledOnce();
 });
 it("persists pending cleanup on storage failure and retries idempotently",async()=>{
  const s=await seed();storage.delete.mockRejectedValueOnce(new Error("private failure"));
  expect((await deleteReceiptRow(db,storage,s.row.id)).cleanup).toBe("pending");
  const [entry]=await db.select().from(receiptCleanup).where(eq(receiptCleanup.storageKey,s.photo.storageKey));expect(entry!.completedAt).toBeNull();
  await retryReceiptCleanup(db,storage);expect((await db.select().from(receiptCleanup).where(eq(receiptCleanup.id,entry!.id)))[0]!.completedAt).not.toBeNull();
  storage.delete.mockClear();await retryReceiptCleanup(db,storage);expect(storage.delete).not.toHaveBeenCalled();
  expect((await deleteReceiptRow(db,storage,s.row.id)).deleted).toBe(false);
 });
 it("rolls back DB deletion and outbox if deletion audit fails",async()=>{
  const s=await seed();storage.delete.mockClear();
  // Inject failure at the final durable audit write within the transaction.
  const wrapped={...db,transaction:(fn:(tx:Db)=>Promise<unknown>)=>db.transaction(tx=>fn(new Proxy(tx as unknown as Db,{get(target,key){if(key==="insert")return (table:unknown)=>{if(table===auditLog)throw new Error("audit unavailable");return target.insert(table as typeof auditLog);};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}})))} as Db;
  await expect(deleteReceiptRow(wrapped,storage,s.row.id)).rejects.toThrow("audit unavailable");
  expect(await db.select().from(ocrRows).where(eq(ocrRows.id,s.row.id))).toHaveLength(1);
  expect(await db.select().from(receiptCleanup).where(eq(receiptCleanup.storageKey,s.photo.storageKey))).toHaveLength(0);expect(storage.delete).not.toHaveBeenCalled();
 });
 it("queued OCR is a no-op after deletion without reading storage",async()=>{
  const s=await seed();await deleteReceiptRow(db,storage,s.row.id);const reader=vi.fn();
  expect((await processOcrRow(db,new OcrFake(),s.row.id,reader)).status).toBe("DELETED");expect(reader).not.toHaveBeenCalled();
 });
 it.each([false,true])("in-flight OCR cannot recreate deleted state or audit (failure=%s)",async failing=>{
  const s=await seed();let start!:()=>void;let release!:()=>void;const entered=new Promise<void>(r=>start=r);const gate=new Promise<void>(r=>release=r);
  const extracting=processOcrRow(db,{extract:async image=>{start();await gate;if(failing)throw new Error("failed");return new OcrFake().extract(image);}},s.row.id,async()=>new Uint8Array([0x42]));
  await entered;await deleteReceiptRow(db,storage,s.row.id);release();expect((await extracting).status).toBe("DELETED");
  expect(await db.select().from(auditLog).where(eq(auditLog.rowId,s.row.id))).toHaveLength(0);
 });
 it("approval winning the row lock prevents deletion",async()=>{
  const s=await seed();await db.update(ocrRows).set({recipientMode:"identified",taxRate:21,status:"CONFIDENT",cuit:"30710145764",fields:{name:"Payer",date:"2026-10-28",amount:100}}).where(eq(ocrRows.id,s.row.id));
  const invoice=await materializeInvoice(db,s.row.id);await markInvoiceReviewed(db,invoice.id);
  let start!:()=>void;let release!:()=>void;const entered=new Promise<void>(r=>start=r);const gate=new Promise<void>(r=>release=r);
  const gateway=new ArcaGatewayFake();vi.spyOn(gateway,"getIvaCondition").mockImplementation(async()=>{start();await gate;return "ri";});
  const approving=approveInvoice(db,gateway,invoice.id);await entered;const deleting=deleteReceiptRow(db,storage,s.row.id);const rejected=expect(deleting).rejects.toBeInstanceOf(ReceiptDeletionStateError);release();
  await approving;await rejected;expect(await db.select().from(ocrRows).where(eq(ocrRows.id,s.row.id))).toHaveLength(1);
 });
 it("failed approval audit cannot recreate a foreign key after deletion wins",async()=>{
  const s=await seed();await db.update(ocrRows).set({recipientMode:"identified",taxRate:21,status:"CONFIDENT",cuit:"30710145764",fields:{name:"Payer",date:"2026-10-28",amount:100}}).where(eq(ocrRows.id,s.row.id));
  const invoice=await materializeInvoice(db,s.row.id);await markInvoiceReviewed(db,invoice.id);
  let start!:()=>void;let release!:()=>void;const entered=new Promise<void>(r=>start=r);const gate=new Promise<void>(r=>release=r);
  const gateway=new ArcaGatewayFake();vi.spyOn(gateway,"getIvaCondition").mockImplementation(async()=>{start();await gate;return "unresolved";});
  const approving=approveInvoice(db,gateway,invoice.id);const failed=expect(approving).rejects.toThrow(/has no Padr/);await entered;
  const deleting=deleteReceiptRow(db,storage,s.row.id);release();await deleting;await failed;
  expect(await db.select().from(auditLog).where(eq(auditLog.invoiceId,invoice.id))).toHaveLength(0);
 });
 it("removes every deletable invoice and preserves a batch with other photos",async()=>{
  const s=await seed("PENDING");await db.insert(invoices).values({ocrRowId:s.row.id,clientId,status:"REJECTED"});
  await db.insert(photos).values({batchId:s.batch.id,storageKey:randomUUID()});await deleteReceiptRow(db,storage,s.row.id);
  expect(await db.select().from(invoices).where(eq(invoices.ocrRowId,s.row.id))).toHaveLength(0);
  expect(await db.select().from(batches).where(eq(batches.id,s.batch.id))).toHaveLength(1);
 });

 it("scrubs receipt fields and CUIT from retained affected audit payloads",async()=>{
  const s=await seed("PENDING");
  await db.insert(auditLog).values([{actor:"accountant",action:"row.corrected",rowId:s.row.id,invoiceId:s.invoice!.id,payload:{before:{name:"Sensitive Original",amount:98765,cuit:"30710145764"},after:{name:"Sensitive Corrected",date:"2026-10-28"}}},{actor:"accountant",action:"invoice.reviewed",invoiceId:s.invoice!.id,payload:{name:"Sensitive Snapshot",cuit:"30710145764"}}]);
  await deleteReceiptRow(db,storage,s.row.id);
  const audits=(await db.select().from(auditLog)).filter(a=>(a.payload as {deletedInvoiceId?:string})?.deletedInvoiceId===s.invoice!.id);
  expect(audits).toHaveLength(2);expect(audits.map(a=>a.action)).toEqual(["row.corrected","invoice.reviewed"]);
  const contents=JSON.stringify(audits.map(a=>a.payload));expect(contents).not.toContain("Sensitive");expect(contents).not.toContain("30710145764");expect(contents).not.toContain("98765");
 });

 it("cleanup retry refuses to unlink a file now referenced by a live photo",async()=>{
  const s=await seed();storage.delete.mockRejectedValueOnce(new Error("offline"));await deleteReceiptRow(db,storage,s.row.id);
  await seed(undefined,s.photo.storageKey);storage.delete.mockClear();await retryReceiptCleanup(db,storage);expect(storage.delete).not.toHaveBeenCalledWith(s.photo.storageKey);
  const [entry]=await db.select().from(receiptCleanup).where(eq(receiptCleanup.rowId,s.row.id));expect(entry!.completedAt).toBeNull();
 });

});
