import { describe, expect, it } from "vitest";
import type { ReviewInvoiceRow } from "@/lib/review/read-model";
import { isEditable, reviewBlockReason, statusLabel } from "./workbench-state";
const row:ReviewInvoiceRow={recipientMode:"identified",recipientModeSource:"legacy_migration",taxRate:21,issuerCondition:"ri",rowId:"row",status:"CONFIDENT",cuit:"30710145764",cuitSource:"ocr",fields:{name:"Payer",amount:100,date:"2026-10-28"},confidence:{name:0.9},manualFields:[],issuerCuit:"20123456786",ptoVta:1,clientId:"client",razonSocial:"Issuer",blocked:false,failed:false,error:null,invoiceId:"invoice",invoiceStatus:"PENDING",flagged:false};
describe("workbench affordances",()=>{
 it("matches anonymous readiness and exact identification boundary",()=>{
  const cf={...row,recipientMode:"consumer_final" as const,cuit:null,fields:{...row.fields,name:"",amount:999999999}};
  expect(reviewBlockReason(cf)).toBeNull();expect(reviewBlockReason({...cf,fields:{...cf.fields,amount:1000000000}})).toMatch(/identificar/);
  expect(reviewBlockReason({...cf,taxRate:null})).toMatch(/alícuota/);
  expect(reviewBlockReason({...cf,taxRate:null,issuerCondition:"monotributista"})).toBeNull();
 });
 it("separates correction, confirmation and approval states",()=>{expect(isEditable(row)).toBe(true);expect(reviewBlockReason(row)).toBeNull();expect(statusLabel(row)).toBe("Pendiente de revisión");expect(statusLabel({...row,invoiceStatus:"REVIEWED"})).toBe("Revisado");expect(statusLabel({...row,invoiceStatus:"APPROVED"})).not.toBe("Emitido");});
 it.each(["APPROVED","EMITTING","EMITTED","EMIT_ERROR","EMIT_FAILED","REJECTED"])("terminal/in-flight %s is read-only even with flagged data",invoiceStatus=>{expect(isEditable({...row,invoiceStatus,flagged:true,blocked:true})).toBe(false);});
 it.each(["PENDING","FAILED"])("unfinished %s OCR cannot be edited or confirmed",status=>{const input={...row,status,failed:status==="FAILED"};expect(isEditable(input)).toBe(false);expect(reviewBlockReason(input)).not.toBeNull();});
 it("complete BLOCKED data can be confirmed without fake corrections",()=>{const input={...row,blocked:true,status:"BLOCKED"};expect(reviewBlockReason(input)).toBeNull();expect(statusLabel(input)).toBe("Pendiente de revisión");});
 it.each([{cuit:null},{fields:{...row.fields,name:""}},{fields:{...row.fields,date:"2026-02-30"}},{fields:{...row.fields,amount:0}}])("invalid required fields block confirmation: %j",invalid=>{expect(reviewBlockReason({...row,...invalid})).not.toBeNull();});
});
