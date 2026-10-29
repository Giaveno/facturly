/** Manual homologacion only. Default is read-only preflight; never invoke a worker. */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDiagnostic } from "../src/lib/homologacion/diagnostic";
import { createDiagnosticSession } from "../src/lib/homologacion/live-session";
import { buildInvoicePdfModel, renderInvoicePdf } from "../src/pdf/render";
import * as schema from "../src/lib/db/schema";
import type { FECAEReq } from "../src/ports/arca-gateway";

async function main() {
 const args=process.argv.slice(2);
 const value=(flag:string)=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
 const clientId=value("--client-id");
 if(!clientId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))throw Error("A safe existing --client-id UUID is required");
 // Load in-process only; never print configuration or read/change production-confirmation settings.
 process.loadEnvFile(".env");
 if(process.env.ARCA_ENV!=="homologacion")throw Error("ARCA_ENV must be exactly homologacion; no DB or credentials opened");
 const authOnly=args.includes("--auth-only"),emitOnce=args.includes("--emit-once"),expectedFile=value("--expected-file"),invoiceId=value("--invoice-id");
 if(authOnly&&(emitOnce||expectedFile||invoiceId||args.includes("--pdf")||args.includes("--preflight")))throw Error("auth-only cannot be combined with preflight, issuance or PDF arguments");
 if(emitOnce&&args.includes("--preflight"))throw Error("Preflight and emit-once are mutually exclusive");
 if(emitOnce&&(!expectedFile||!invoiceId))throw Error("--emit-once requires --invoice-id and --expected-file with whole expected request");
 const expected=expectedFile?JSON.parse(await readFile(expectedFile,"utf8")) as FECAEReq:undefined;
 if(!process.env.DATABASE_URL)throw Error("Existing database connection is required");
 if(invoiceId&&!/^[0-9a-f-]{36}$/i.test(invoiceId))throw Error("Safe invoice UUID required");
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:6000,statement_timeout:5000,max:1});
 const db=drizzle(pool,{schema});
 try{
  const report=await runDiagnostic({environment:process.env.ARCA_ENV,open:id=>createDiagnosticSession(db,process.env,id,{authOnly,debug:args.includes("--debug-soap"),onAuthorized:args.includes("--pdf")?async(request,result)=>{
   const model=buildInvoicePdfModel({environment:"homologacion",cuit:request.cuit,ptoVta:request.ptoVta,cbteTipo:request.cbteTipo,cbteNro:result.cbteNro,cae:result.cae,caeFchVto:result.caeFchVto,fechaEmision:request.fechaEmision,importeTotal:request.importeTotal,moneda:request.moneda,receptorDocTipo:request.receptorDocTipo,receptorDocNro:request.receptorDocNro,condicionIvaReceptorId:request.condicionIvaReceptorId,receptorRazonSocial:request.receptorRazonSocial});
   const directory=resolve(".data","homologacion");await mkdir(directory,{recursive:true});await writeFile(resolve(directory,`${invoiceId}.pdf`),await renderInvoicePdf(model));
   console.log("Homologacion PDF written after matching authorization.");
  }:undefined})},{clientId,authOnly,emitOnce,invoiceId,expected});
  console.log(JSON.stringify(report,null,2));
  process.exitCode=report.blockers.length?2:0;
 }finally{await pool.end();}
}
main().catch(()=>{console.error("Diagnostic stopped safely. Verify environment, arguments, existing client and database prerequisites; no automatic retry.");process.exitCode=2;});
