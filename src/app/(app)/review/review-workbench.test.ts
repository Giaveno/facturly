import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewInvoiceRow } from "@/lib/review/read-model";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
import ReviewWorkbench from "./review-workbench";
const row:ReviewInvoiceRow={recipientMode:"identified",recipientModeSource:"legacy_migration",taxRate:21,issuerCondition:"ri",rowId:"00000000-0000-4000-8000-000000000000",status:"CONFIDENT",cuit:"30710145764",cuitSource:"ocr",fields:{name:"Real payer",amount:100,date:"2026-10-28"},confidence:{name:0.9},manualFields:[],issuerCuit:"20123456786",ptoVta:1,clientId:"client",razonSocial:"Actual issuer",blocked:false,failed:false,error:null,invoiceId:"invoice",invoiceStatus:"PENDING",flagged:false};
const render=(rows:ReviewInvoiceRow[])=>renderToStaticMarkup(createElement(ReviewWorkbench,{rows,environment:"homologacion"}));
describe("review workbench server markup (not browser verification)",()=>{
 it("renders explicit anonymous CF without presenting stale OCR CUIT as fiscal identity",()=>{
  const html=render([{...row,recipientMode:"consumer_final",recipientModeSource:"upload_default",cuit:"30710145764",issuerCondition:"monotributista",taxRate:null}]);
  expect(html).toContain("Consumidor Final");expect(html).toContain("Modo predeterminado de la carga");
  expect(html).not.toContain("CUIT del destinatario");expect(html).not.toContain("30710145764");
  expect(html).toContain("solo referencia, no receptor fiscal");expect(html).toContain("Solo productos");expect(html).not.toContain("\\u00");
 });
 it("explains identified verification and blocks RI without a selected taxable rate",()=>{
  const html=render([{...row,taxRate:null}]);expect(html).toContain("Facturar a un CUIT");expect(html).toContain("se clasifica en Padrón al aprobar");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirmar revisión<\/button>/);
 });
 it.each(["CONFIDENT","BLOCKED","CORRECTED"])("%s requires explicit review with no numerical certainty or exceptional warning",status=>{
  const html=render([{...row,status,blocked:status==="BLOCKED",confidence:{name:0.79,cuit:0.79,amount:0.79,date:0.79}}]);
  expect(html).toContain("Pendiente de revisión");
  expect(html).toMatch(/<button[^>]*class="btn"[^>]*>Confirmar revisión<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Confirmar revisión<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Aprobar<\/button>/);
  expect(html).not.toMatch(/79\s*%|certeza|Requiere atención|Requiere revisión|source-note alert/);
  expect(html).toContain("Origen: OCR");
 });
 it("manual provenance does not expose original confidence",()=>{const html=render([{...row,manualFields:["name"],confidence:{name:0.79}}]);expect(html).toContain("Origen: corrección manual");expect(html).not.toMatch(/79\s*%|certeza|OCR original/);});
 it("renders actual row/issuer/image endpoint, separate actions, and no simulated receipt",()=>{const html=render([row]);expect(html).toContain("Revisión de comprobantes");expect(html).not.toContain("Revisi?n");expect(html).toContain("Actual issuer");expect(html).toContain("Real payer");expect(html).toContain("20123456786");expect(html).toContain(`/api/rows/${row.rowId}/image`);expect(html).toContain("Confirmar revisión");expect(html).toContain("Editar datos");expect(html).toContain("Aprobar");expect(html).not.toContain("SIMULADA");expect(html).not.toContain("mock-emblem");});
 it("renders empty state honestly",()=>{expect(render([])).toContain("No hay comprobantes para revisar");});
 it.each(["PENDING","FAILED"])("explains unfinished extraction %s and exposes no edit action",status=>{const html=render([{...row,status,failed:status==="FAILED"}]);expect(html).not.toContain(">Editar datos<");expect(html).toContain("Actualizar estado");});
 it.each(["APPROVED","EMITTING","EMITTED","EMIT_ERROR","EMIT_FAILED","REJECTED"])("%s is read-only",invoiceStatus=>{const html=render([{...row,invoiceStatus}]);expect(html).toContain("Edición no disponible");expect(html).not.toContain(">Editar datos<");expect(html).not.toContain(">Confirmar revisión<");});
});
