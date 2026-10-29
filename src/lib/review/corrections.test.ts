import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { batches, clients, invoices, ocrRows, photos, auditLog, payers } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { saveCorrections, validateCorrections } from "./corrections";
import { materializeInvoice, markInvoiceReviewed, approveInvoice } from "./workflow";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";

describe("explicit correction workflow", () => {
 let db: Db; let close: () => Promise<void>; let clientId: string;
 beforeAll(async () => { ({ db, close } = await createTestDb()); const [c] = await db.insert(clients).values({ cuit: "20123456786", razonSocial: "Issuer", ptoVta: 1, condicionIva: "ri" }).returning(); clientId = c!.id; });
 afterAll(async () => { await close(); });
 async function seed(status: "PENDING" | "CONFIDENT" | "BLOCKED" | "FAILED" = "BLOCKED") {
  const [b] = await db.insert(batches).values({clientId}).returning(); const [p] = await db.insert(photos).values({batchId:b!.id,storageKey:"legacy.jpg"}).returning();
  const [r] = await db.insert(ocrRows).values({recipientMode:"identified",taxRate:21,photoId:p!.id,status,fields:{name:"Before",amount:0,date:""},confidence:{name:0.3},cuit:null}).returning(); return r!.id;
 }
 const correction = {recipientMode:"identified" as const,taxRate:21, name: "Verified payer", cuit: "30710145764", date: "2026-10-27", amount: 121000 };
 it("confirms complete conservative Gemini data without corrections or registry learning", async () => {
  const id = await seed();
  const fields = { name: correction.name, amount: correction.amount, date: correction.date };
  const confidence = { name: 0.79, amount: 0.79, date: 0.79, cuit: 0.79 };
  await db.update(ocrRows).set({ fields, cuit: correction.cuit, cuitSource: "ocr", confidence }).where(eq(ocrRows.id,id));
  const inv = await materializeInvoice(db,id);
  const registryBefore = await db.select().from(payers);
  const gateway = new ArcaGatewayFake();
  const lookup = vi.spyOn(gateway,"getIvaCondition");
  await expect(approveInvoice(db,gateway,inv.id)).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
  expect((await markInvoiceReviewed(db,inv.id)).status).toBe("REVIEWED");
  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id,id));
  expect(row).toMatchObject({fields,cuit:correction.cuit,cuitSource:"ocr",confidence,status:"CORRECTED"});
  expect(await db.select().from(payers)).toEqual(registryBefore);
  const audit = await db.select().from(auditLog).where(eq(auditLog.rowId,id));
  expect(audit.map(a=>a.action)).toEqual(["invoice.reviewed"]);
  expect(audit[0]!.payload).toMatchObject({source:"manual_validation",previousRowStatus:"BLOCKED"});
  expect((await materializeInvoice(db,id)).status).toBe("REVIEWED");
  expect((await approveInvoice(db,gateway,inv.id)).status).toBe("APPROVED");
 });
 it("rejects a complete BLOCKED extraction missing CUIT without changing its state", async () => {
  const id = await seed();
  await db.update(ocrRows).set({fields:{name:correction.name,date:correction.date,amount:correction.amount}}).where(eq(ocrRows.id,id));
  const inv = await materializeInvoice(db,id);
  await expect(markInvoiceReviewed(db,inv.id)).rejects.toThrow(/CUIT/);
  expect((await materializeInvoice(db,id)).status).toBe("PENDING");
  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id,id));
  expect(row!.status).toBe("BLOCKED");
 });
 it.each(["CONFIDENT","CORRECTED"] as const)("complete %s data never confirms itself", async status => {
  const id = await seed();
  await db.update(ocrRows).set({status,fields:{name:correction.name,date:correction.date,amount:correction.amount},cuit:correction.cuit}).where(eq(ocrRows.id,id));
  const inv = await materializeInvoice(db,id);
  expect(inv.status).toBe("PENDING");
  expect((await materializeInvoice(db,id)).status).toBe("PENDING");
  await expect(approveInvoice(db,new ArcaGatewayFake(),inv.id)).rejects.toThrow();
  expect((await markInvoiceReviewed(db,inv.id)).status).toBe("REVIEWED");
 });
 it("saves without confirming, preserves confidence, audits manual fields, invalidates review and syncs stale zero snapshot", async () => {
  const id = await seed(); const inv = await materializeInvoice(db,id);
  await saveCorrections(db,id,correction);
  const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id,id)); expect(row!.confidence).toEqual({name:0.3}); expect(row!.status).toBe("CORRECTED");
  expect((await materializeInvoice(db,id)).status).toBe("PENDING");
  let [invoice] = await db.select().from(invoices).where(eq(invoices.id,inv.id)); expect(invoice!.importeTotalCentavos).toBe(121000);
  await expect(approveInvoice(db,new ArcaGatewayFake(),inv.id)).rejects.toThrow();
  await markInvoiceReviewed(db,inv.id); await saveCorrections(db,id,{...correction,amount:242000});
  [invoice] = await db.select().from(invoices).where(eq(invoices.id,inv.id)); expect(invoice!.status).toBe("PENDING"); expect(invoice!.importeTotalCentavos).toBe(242000);
  const registry = await db.select().from(payers);expect(registry.some(p=>p.cuit===correction.cuit && p.learnedFrom==="manual")).toBe(true);
  const audit = await db.select().from(auditLog).where(eq(auditLog.rowId,id)); expect(audit.some(a=>a.action==="row.corrected")).toBe(true);
 });
 it.each(["PENDING", "FAILED"] as const)("cannot edit or confirm %s OCR",async status=>{const id=await seed(status); const inv=await materializeInvoice(db,id); await expect(saveCorrections(db,id,correction)).rejects.toThrow(); await expect(markInvoiceReviewed(db,inv.id)).rejects.toThrow();});
 it.each(["APPROVED","EMITTING","EMITTED","EMIT_ERROR","EMIT_FAILED","REJECTED"] as const)("cannot edit %s invoice",async status=>{const id=await seed(); const inv=await materializeInvoice(db,id); await db.update(invoices).set({status}).where(eq(invoices.id,inv.id)); await expect(saveCorrections(db,id,correction)).rejects.toThrow();});
 it("cannot confirm incomplete confident data",async()=>{const id=await seed("CONFIDENT"); const inv=await materializeInvoice(db,id); await expect(markInvoiceReviewed(db,inv.id)).rejects.toThrow();});
 it.each([{name:""},{cuit:"123"},{date:"2026-02-30"},{date:"27/10/2026"},{amount:0},{amount:1.5},{amount:Number.MAX_SAFE_INTEGER+1}])("rejects invalid correction %j",invalid=>{expect(()=>validateCorrections({...correction,...invalid})).toThrow();});
 it("approval derives current corrected amount, never a stale materialized snapshot",async()=>{
  const id=await seed();const inv=await materializeInvoice(db,id);await saveCorrections(db,id,correction);await markInvoiceReviewed(db,inv.id);
  await db.update(invoices).set({importeTotalCentavos:0}).where(eq(invoices.id,inv.id));
  const approved=await approveInvoice(db,new ArcaGatewayFake(),inv.id,()=>new Date("2026-10-28T12:00:00Z"));
  expect(approved.importeTotalCentavos).toBe(correction.amount);expect(approved.fechaEmision).toBe("2026-10-28");expect(correction.date).not.toBe(approved.fechaEmision);
 });
 it("confirmation refreshes an invoice materialized before OCR completed",async()=>{
  const id=await seed("PENDING");const inv=await materializeInvoice(db,id);
  await db.update(ocrRows).set({status:"CONFIDENT",fields:{name:correction.name,date:correction.date,amount:correction.amount},cuit:correction.cuit}).where(eq(ocrRows.id,id));
  await markInvoiceReviewed(db,inv.id);const [invoice]=await db.select().from(invoices).where(eq(invoices.id,inv.id));expect(invoice!.importeTotalCentavos).toBe(correction.amount);
 });
 it("serializes correction against in-flight approval; approved fields are immutable",async()=>{
  const id=await seed();const inv=await materializeInvoice(db,id);await saveCorrections(db,id,correction);await markInvoiceReviewed(db,inv.id);
  const gateway=new ArcaGatewayFake();let started!:()=>void;let release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  vi.spyOn(gateway,"getIvaCondition").mockImplementation(async()=>{started();await gate;return "ri";});
  const approving=approveInvoice(db,gateway,inv.id);await entered;
  const editing=saveCorrections(db,id,{...correction,amount:999999});const rejected=expect(editing).rejects.toThrow();release();
  expect((await approving).importeTotalCentavos).toBe(correction.amount);await rejected;
  const [row]=await db.select().from(ocrRows).where(eq(ocrRows.id,id));expect(row!.fields.amount).toBe(correction.amount);
 });
 it("correction winning the race revokes old confirmation before approval",async()=>{
  const id=await seed();const inv=await materializeInvoice(db,id);await saveCorrections(db,id,correction);await markInvoiceReviewed(db,inv.id);
  const saving=saveCorrections(db,id,{...correction,amount:222222});const approval=approveInvoice(db,new ArcaGatewayFake(),inv.id);
  const results=await Promise.allSettled([saving,approval]);expect(results[0]!.status).toBe("fulfilled");expect(results[1]!.status).toBe("rejected");
 });

 it("rejects a stale tab's displayed approval snapshot after another correction and confirmation",async()=>{
  const id=await seed();const inv=await materializeInvoice(db,id);await saveCorrections(db,id,correction);await markInvoiceReviewed(db,inv.id);
  const expected={rowId:id,...correction,issuerCuit:"20123456786",issuerName:"Issuer",issuerCondition:"ri" as const,ptoVta:1,environment:"homologacion" as const};
  await saveCorrections(db,id,{...correction,amount:999999});await markInvoiceReviewed(db,inv.id);
  const gateway=new ArcaGatewayFake();const lookup=vi.spyOn(gateway,"getIvaCondition");
  await expect(approveInvoice(db,gateway,inv.id,()=>new Date(),expected)).rejects.toThrow();expect(lookup).not.toHaveBeenCalled();
  const [invoice]=await db.select().from(invoices).where(eq(invoices.id,inv.id));expect(invoice!.status).toBe("REVIEWED");
 });

 it("approves exactly the displayed, confirmed fiscal context",async()=>{
  const id=await seed();const inv=await materializeInvoice(db,id);await saveCorrections(db,id,correction);await markInvoiceReviewed(db,inv.id);
  const expected={rowId:id,...correction,issuerCuit:"20123456786",issuerName:"Issuer",issuerCondition:"ri" as const,ptoVta:1,environment:"homologacion" as const};
  expect((await approveInvoice(db,new ArcaGatewayFake(),inv.id,()=>new Date(),expected)).status).toBe("APPROVED");
 });

});
