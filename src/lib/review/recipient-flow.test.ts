import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test-support/test-db";
import { auditLog, batches, clients, delegations, invoices, issuedInvoices, ocrRows, payers, photos } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { materializeInvoice, markInvoiceReviewed, approveInvoice } from "./workflow";
import { saveCorrections } from "./corrections";
import { listReviewInvoices } from "./read-model";
import { processUpload, queueUpload } from "@/lib/pipeline/ingest";
import { processOcrRow } from "@/lib/ocr/process";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { listExportRows } from "@/adapters/export";
import { loadIssuedInvoicePdfInput } from "@/lib/invoices/read-model";
import { emitInvoice, NumberAllocator } from "@/lib/emission/emission-service";

describe("primary explicit recipient flow (offline)", () => {
 let db: Db; let close: () => Promise<void>; let mono: string; let ri: string;
 beforeAll(async () => {
  ({db,close} = await createTestDb());
  const rows = await db.insert(clients).values([
   {cuit:"20123456786",razonSocial:"Mono",ptoVta:1,condicionIva:"monotributista"},
   {cuit:"30710145764",razonSocial:"RI",ptoVta:1,condicionIva:"ri"},
  ]).returning(); mono=rows[0]!.id; ri=rows[1]!.id;
 });
 afterAll(async () => close());
 it("anonymous uploads never acquire registry identity/audit, even for a known payer",async()=>{
  await db.insert(payers).values({name:"Known offline payer",cvu:"0000003100000000000001",cuit:"20123456786",learnedFrom:"manual"}).onConflictDoNothing();
  const queued=await queueUpload(mono,[{storageKey:"anonymous-known.jpg",image:new Uint8Array([2])}],{db});
  const rowId=queued.rows[0]!.id;await processOcrRow(db,new OcrFake(),rowId,async()=>new Uint8Array([2]));
  const synchronous=await processUpload(mono,[{storageKey:"anonymous-known-sync.jpg",image:new Uint8Array([2])}],{db,ocr:new OcrFake()});
  for(const id of [rowId,synchronous.rows[0]!.id]) {
   const [row]=await db.select().from(ocrRows).where(eq(ocrRows.id,id));expect(row).toMatchObject({recipientMode:"consumer_final",cuit:null,cuitSource:null});
   expect((await db.select().from(auditLog).where(eq(auditLog.rowId,id))).some(a=>a.action==="payer.cuit_registry_resolved")).toBe(false);
  }
 });
 it("upload→OCR→manual confirmation→approval has no issuance or downloadable PDF",async()=>{
  const uploaded=await queueUpload(mono,[{storageKey:"offline-upload.jpg",image:new Uint8Array([2])}],{db});
  const rowId=uploaded.rows[0]!.id;const inv=await materializeInvoice(db,rowId);const gateway=new ArcaGatewayFake();const lookup=vi.spyOn(gateway,"getIvaCondition");
  await expect(markInvoiceReviewed(db,inv.id)).rejects.toThrow();
  await processOcrRow(db,new OcrFake(),rowId,async()=>new Uint8Array([2]));
  expect((await materializeInvoice(db,rowId)).status).toBe("PENDING");
  expect(await loadIssuedInvoicePdfInput(db,inv.id)).toBeNull();
  await markInvoiceReviewed(db,inv.id);
  const exportRow=(await listExportRows(db)).find(r=>r.payerName==="Consumidor Final");
  expect(exportRow).toMatchObject({cuit:null,documentType:99,documentNumber:0,status:"REVIEWED"});
  await approveInvoice(db,gateway,inv.id);
  expect(lookup).not.toHaveBeenCalled();expect(await loadIssuedInvoicePdfInput(db,inv.id)).toBeNull();
  expect(await db.select().from(issuedInvoices)).toEqual([]);
 });
 async function seed(clientId=mono) {
  const [b]=await db.insert(batches).values({clientId}).returning();
  const [p]=await db.insert(photos).values({batchId:b!.id,storageKey:"offline.jpg"}).returning();
  const [r]=await db.insert(ocrRows).values({photoId:p!.id,status:"BLOCKED",fields:{name:"Original OCR",date:"2026-10-28",amount:12100},confidence:{name:0.5},cuit:"30710145764",cuitSource:"ocr"}).returning();
  const inv=await materializeInvoice(db,r!.id); return {row:r!,invoiceId:inv.id};
 }
 it("defaults to CF, requires explicit review/approval and never looks up Padrón or emits",async()=>{
  const {row,invoiceId}=await seed(); const gateway=new ArcaGatewayFake();
  const lookup=vi.spyOn(gateway,"getIvaCondition"); const emit=vi.spyOn(gateway,"issueInvoice");
  expect(row.recipientMode).toBe("consumer_final");
  expect((await listReviewInvoices(db)).find(r=>r.rowId===row.id)?.flagged).toBe(false);
  await expect(approveInvoice(db,gateway,invoiceId)).rejects.toThrow();
  await markInvoiceReviewed(db,invoiceId);
  const approved=await approveInvoice(db,gateway,invoiceId);
  expect(approved).toMatchObject({status:"APPROVED",cbteTipo:11,receptorDocTipo:99,receptorDocNro:0,condicionIvaReceptorId:5,receptorRazonSocial:"Consumidor Final",importeNetoCentavos:12100,importeIvaCentavos:0});
  expect(lookup).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();expect(await db.select().from(issuedInvoices)).toEqual([]);
  const [current]=await db.select().from(ocrRows).where(eq(ocrRows.id,row.id));expect(current!.confidence).toEqual(row.confidence);expect(current!.fields).toEqual(row.fields);
 });
 it("saving CF ignores stale CUIT, never teaches registry, revokes confirmation",async()=>{
  const {row,invoiceId}=await seed();await markInvoiceReviewed(db,invoiceId);
  const before=await db.select().from(payers);
  await saveCorrections(db,row.id,{...row.fields,cuit:row.cuit,recipientMode:"consumer_final",taxRate:null});
  expect(await db.select().from(payers)).toEqual(before);
  const [current]=await db.select().from(ocrRows).where(eq(ocrRows.id,row.id));expect(current).toMatchObject({recipientMode:"consumer_final",cuit:null});
  await expect(approveInvoice(db,new ArcaGatewayFake(),invoiceId)).rejects.toThrow();
 });
 it("identified CUIT is classified each approval; unresolved condition fails closed",async()=>{
  const {row,invoiceId}=await seed(ri);
  await saveCorrections(db,row.id,{...row.fields,cuit:"30-71014576-4",recipientMode:"identified",taxRate:21});
  await markInvoiceReviewed(db,invoiceId);const gateway=new ArcaGatewayFake();const lookup=vi.spyOn(gateway,"getIvaCondition").mockResolvedValueOnce("unresolved").mockResolvedValueOnce("monotributista");
  await expect(approveInvoice(db,gateway,invoiceId)).rejects.toThrow();
  expect((await approveInvoice(db,gateway,invoiceId))).toMatchObject({cbteTipo:1,receptorDocTipo:80,receptorDocNro:30710145764,condicionIvaReceptorId:6,importeNetoCentavos:10000,importeIvaCentavos:2100,taxRate:21});
  expect(lookup).toHaveBeenNthCalledWith(2,"30710145764","30710145764");
 });
 it("RI consumer-final B needs explicit taxable rate before confirmation",async()=>{
  const {row,invoiceId}=await seed(ri);await expect(markInvoiceReviewed(db,invoiceId)).rejects.toThrow(/alícuota/);
  await saveCorrections(db,row.id,{...row.fields,cuit:"",recipientMode:"consumer_final",taxRate:10.5});
  await markInvoiceReviewed(db,invoiceId);const gateway=new ArcaGatewayFake();const lookup=vi.spyOn(gateway,"getIvaCondition");
  expect(await approveInvoice(db,gateway,invoiceId)).toMatchObject({cbteTipo:6,importeNetoCentavos:10950,importeIvaCentavos:1150,taxRate:10.5});expect(lookup).not.toHaveBeenCalled();
 });
 it("mode switch and stale snapshot cannot reuse prior review",async()=>{
  const {row,invoiceId}=await seed();await markInvoiceReviewed(db,invoiceId);
  const expected={rowId:row.id,...row.fields,cuit:"",recipientMode:"consumer_final" as const,taxRate:null,issuerCuit:"20123456786",issuerName:"Mono",issuerCondition:"monotributista" as const,ptoVta:1,environment:"homologacion" as const};
  await saveCorrections(db,row.id,{...row.fields,cuit:"30710145764",recipientMode:"identified",taxRate:null});
  await expect(approveInvoice(db,new ArcaGatewayFake(),invoiceId,undefined,expected,"homologacion")).rejects.toThrow();
  await markInvoiceReviewed(db,invoiceId);
  await expect(approveInvoice(db,new ArcaGatewayFake(),invoiceId,undefined,expected,"homologacion")).rejects.toThrow(/stale/);
  const [invoice]=await db.select().from(invoices).where(eq(invoices.id,invoiceId));expect(invoice!.status).toBe("REVIEWED");
 });
 it("changing CUIT refreshes Padrón and lookup errors never approve or leak provider errors",async()=>{
  const {row,invoiceId}=await seed(ri);const gateway=new ArcaGatewayFake();const lookup=vi.spyOn(gateway,"getIvaCondition").mockRejectedValueOnce(new Error("PRIVATE_TOKEN_RAW_BODY")).mockResolvedValueOnce("exento");
  await saveCorrections(db,row.id,{...row.fields,recipientMode:"identified",taxRate:21,cuit:"30710145764"});await markInvoiceReviewed(db,invoiceId);
  let failure:unknown;try {await approveInvoice(db,gateway,invoiceId);}catch(error){failure=error;}
  expect(String(failure)).not.toContain("PRIVATE_TOKEN");
  expect((await db.select().from(invoices).where(eq(invoices.id,invoiceId)))[0]!.status).toBe("REVIEWED");
  await saveCorrections(db,row.id,{...row.fields,recipientMode:"identified",taxRate:21,cuit:"20123456786"});await markInvoiceReviewed(db,invoiceId);
  expect(await approveInvoice(db,gateway,invoiceId)).toMatchObject({cbteTipo:6,receptorDocNro:20123456786,condicionIvaReceptorId:4});
  expect(lookup.mock.calls.map(call=>call[1])).toEqual(["30710145764","20123456786"]);
 });
 it("pins fiscal approval context and rejects later issuer edits before reserving or contacting ARCA",async()=>{
  const {row,invoiceId}=await seed();const gateway=new ArcaGatewayFake();const ultimo=vi.spyOn(gateway,"ultimoAutorizado");const issue=vi.spyOn(gateway,"issueInvoice");
  await markInvoiceReviewed(db,invoiceId);const approved=await approveInvoice(db,gateway,invoiceId,undefined,undefined,"homologacion");
  expect(approved).toHaveProperty("approvalSnapshot.environment","homologacion");
  await db.insert(delegations).values({clientId:mono,cuit:"20123456786",enabled:true}).onConflictDoNothing();
  await db.update(clients).set({ptoVta:2}).where(eq(clients.id,mono));
  try {await expect(emitInvoice({db,gateway,emissionsEnabled:true},new NumberAllocator(gateway),invoiceId)).rejects.toThrow(/snapshot/);}
  finally {await db.update(clients).set({ptoVta:1}).where(eq(clients.id,mono));}
  expect(ultimo).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();
  expect(await db.select().from(issuedInvoices).where(eq(issuedInvoices.invoiceId,invoiceId))).toEqual([]);
  const current=(await db.select().from(ocrRows).where(eq(ocrRows.id,row.id)))[0]!;expect(current.recipientMode).toBe("consumer_final");
 });
 it("rejects environment or persisted recipient drift before dispatch",async()=>{
  const {row,invoiceId}=await seed();const gateway=new ArcaGatewayFake();const ultimo=vi.spyOn(gateway,"ultimoAutorizado");const issue=vi.spyOn(gateway,"issueInvoice");
  await markInvoiceReviewed(db,invoiceId);await approveInvoice(db,gateway,invoiceId,undefined,undefined,"homologacion");
  await expect(emitInvoice({db,gateway,emissionsEnabled:true,environment:"production"},new NumberAllocator(gateway),invoiceId)).rejects.toThrow(/snapshot/);
  await db.update(ocrRows).set({recipientMode:"identified"}).where(eq(ocrRows.id,row.id));
  await expect(emitInvoice({db,gateway,emissionsEnabled:true,environment:"homologacion"},new NumberAllocator(gateway),invoiceId)).rejects.toThrow(/snapshot/);
  expect(ultimo).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();
 });
 it.each(["APPROVED","EMITTING","EMIT_ERROR"] as const)("legacy taxable A %s without reviewed rate fails before numbering",async status=>{
  const {row,invoiceId}=await seed(ri);const gateway=new ArcaGatewayFake();
  await saveCorrections(db,row.id,{...row.fields,cuit:"30710145764",recipientMode:"identified",taxRate:21});await markInvoiceReviewed(db,invoiceId);await approveInvoice(db,gateway,invoiceId);
  await db.update(invoices).set({status,taxRate:null,approvalSnapshot:null}).where(eq(invoices.id,invoiceId));
  await db.insert(delegations).values({clientId:ri,cuit:"30710145764",enabled:true}).onConflictDoNothing();
  const ultimo=vi.spyOn(gateway,"ultimoAutorizado").mockRejectedValue(new Error("Unexpected numbering call"));const issue=vi.spyOn(gateway,"issueInvoice");
  await expect(emitInvoice({db,gateway,emissionsEnabled:true},new NumberAllocator(gateway),invoiceId)).rejects.toThrow(/alícuota|IVA|taxable/);
  expect(ultimo).not.toHaveBeenCalled();expect(issue).not.toHaveBeenCalled();
 });
});
