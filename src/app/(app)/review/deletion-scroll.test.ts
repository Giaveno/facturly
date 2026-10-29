import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewInvoiceRow } from "@/lib/review/read-model";
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}));
import ReviewWorkbench from "./review-workbench";
const row:ReviewInvoiceRow={recipientMode:"identified",recipientModeSource:"legacy_migration",taxRate:21,issuerCondition:"ri",rowId:"00000000-0000-4000-8000-000000000000",status:"PENDING",cuit:null,cuitSource:null,fields:{name:"Real payer",amount:100,date:"2026-10-28"},confidence:{},manualFields:[],issuerCuit:"20123456786",ptoVta:1,clientId:"client",razonSocial:"Actual issuer",blocked:false,failed:false,error:null,invoiceId:"invoice",invoiceStatus:"PENDING",flagged:true};
const render=(overrides:Partial<ReviewInvoiceRow>={})=>renderToStaticMarkup(createElement(ReviewWorkbench,{rows:[{...row,...overrides}],environment:"homologacion"}));
describe("receipt deletion and queue markup (not browser checks)",()=>{
 it.each([{status:"PENDING"},{status:"FAILED",failed:true},{invoiceStatus:"REJECTED"}])("allows deletion independently of editability %j",overrides=>{expect(render(overrides)).toContain('>Eliminar definitivamente</button>');expect(render(overrides)).not.toMatch(/disabled=""[^>]*>Eliminar definitivamente/);});
 it.each(["APPROVED","EMITTING","EMITTED","EMIT_ERROR","EMIT_FAILED"])("disables deletion for fiscal state %s",invoiceStatus=>{expect(render({invoiceStatus})).toMatch(/disabled=""[^>]*>Eliminar definitivamente/);});
 it("exposes a focusable named queue region",()=>{const html=render();expect(html).toContain('tabindex="0"');expect(html).toContain('aria-label="Comprobantes de la bandeja"');});
 it("bounds the flex queue and makes scrollbars visible across viewport sizes",()=>{
  const css=readFileSync(new URL("./review-workbench.css",import.meta.url),"utf8");
  expect(css).toMatch(/\.review-page \.queue\{[^}]*min-height:0/);expect(css).toMatch(/\.review-page \.queue-list\{[^}]*min-height:0[^}]*flex:1 1 0/);
  expect(css).toContain("scrollbar-gutter:stable");expect(css).toContain("::-webkit-scrollbar-thumb");expect(css).toContain("max-height:70vh");expect(css).toContain("overflow-x:scroll");
 });
});
