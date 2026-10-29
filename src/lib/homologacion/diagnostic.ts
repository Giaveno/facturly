import type { FECAEReq, IssueInvoiceResult } from "@/ports/arca-gateway";
import type { PointOfSale, WsfeAuth } from "@/adapters/arca/wsfe";
import type { TipoCbte } from "@/adapters/arca/wsfe-diagnostics";
import { ArcaQueryError, safeQueryDiagnostic, type QueryDiagnostic } from "@/adapters/arca/query-diagnostics";
import { ArcaError } from "@/adapters/arca/errors";
import type { TaCacheEntry, TaCacheStore } from "@/adapters/arca/ta-cache";

export interface DiagnosticReservation { invoiceId: string; request: FECAEReq; trustworthy: boolean }
export interface DiagnosticSession {
 context: {client:{id:string;cuit:string;ptoVta:number;condition:string};certificateCuit:string|null;credentialsValid:boolean;migrationReady:boolean;reservations:DiagnosticReservation[]};
 dummy(): Promise<void>;
 auth(): Promise<WsfeAuth>;
 points(auth:WsfeAuth): Promise<PointOfSale[]>;
 ultimo(auth:WsfeAuth,ptoVta:number): Promise<number>;
 types(auth:WsfeAuth): Promise<TipoCbte[]>;
 consult(auth:WsfeAuth,request:FECAEReq): Promise<IssueInvoiceResult|null>;
 beginOnce(invoiceId:string,request:FECAEReq): Promise<void>;
 issue(auth:WsfeAuth,request:FECAEReq): Promise<IssueInvoiceResult>;
 complete(invoiceId:string,request:FECAEReq,result:IssueInvoiceResult): Promise<void>;
 close(): Promise<void>;
}
export interface DiagnosticOptions {clientId:string;authOnly?:boolean;emitOnce?:boolean;invoiceId?:string;expected?:FECAEReq}
interface Step {operation:string;status:"ok"|"blocked"|"skipped";diagnostic?:QueryDiagnostic}
export interface DiagnosticReport {environment:"homologacion";clientId:string;steps:Step[];blockers:string[];migrationReady:boolean;emitted:boolean;authorization?:IssueInvoiceResult}
function diagnostic(error:unknown, operation?:string): QueryDiagnostic|undefined {
 if(error instanceof ArcaQueryError)return error.diagnostic;
 if(error instanceof ArcaError)return safeQueryDiagnostic({stage:operation==="auth"?"wsaa":"wsfe",category:error.category??"internal",providerCodes:error.providerCodes,httpStatus:error.httpStatus});
 return undefined;
}
/** Existing cache reads are allowed; new tickets/deletions never reach durable storage. */
export function memoryOnlyTicketStore(read:(key:string)=>Promise<TaCacheEntry|null>):TaCacheStore {
 const memory=new Map<string,TaCacheEntry|null>();
 return {get:async key=>memory.has(key)?memory.get(key)!:read(key),put:async(key,value)=>{memory.set(key,value);},delete:async key=>{memory.set(key,null);}};
}
/** No environment normalization, issue retries, worker invocation or implicit issuance. */
export async function runDiagnostic(deps:{environment:string|undefined;open:(clientId:string)=>Promise<DiagnosticSession>},options:DiagnosticOptions):Promise<DiagnosticReport> {
 if(deps.environment!=="homologacion")throw Error("ARCA_ENV must be exactly homologacion; no DB or credentials were opened");
 if(options.authOnly&&(options.emitOnce||options.invoiceId||options.expected))throw Error("auth-only cannot be combined with issuance authorization");
 const session=await deps.open(options.clientId),context=session.context;
 const report:DiagnosticReport={environment:"homologacion",clientId:context.client.id,steps:[],blockers:[],migrationReady:context.migrationReady,emitted:false};
 const block=(reason:string)=>{if(!report.blockers.includes(reason))report.blockers.push(reason);};
 const step=async<T>(operation:string,run:()=>Promise<T>):Promise<T|undefined>=>{
  try{const value=await run();report.steps.push({operation,status:"ok"});return value;}
  catch(error){report.steps.push({operation,status:"blocked",diagnostic:diagnostic(error,operation)});block(operation+" failed");return undefined;}
 };
 try{
  if(options.authOnly){
   if(!context.credentialsValid||context.certificateCuit!==context.client.cuit)block("Certificate/key/validity or certificate CUIT differs from Auth.Cuit");
   else await step("auth",session.auth);
   return report;
  }
  if(context.client.condition!=="exento")block("Client condition is not exento; no automatic configuration change");
  if(!context.credentialsValid||context.certificateCuit!==context.client.cuit)block("Certificate/key/validity or certificate CUIT differs from Auth.Cuit");
  await step("dummy",session.dummy);
  const auth=context.credentialsValid&&context.certificateCuit===context.client.cuit?await step("auth",session.auth):undefined;
  const points=auth?await step("points",()=>session.points(auth)):undefined;
  if(!auth)report.steps.push({operation:"points",status:"skipped"});
  const active=points?.some(p=>p.number===context.client.ptoVta&&p.emissionType==="CAE"&&p.status==="available"&&p.blocked===false&&p.deregisteredOn===null)??false;
  if(!active)block("Configured point of sale is not an active authorized CAE point; no PV1 waiver");
  const last=auth&&active?await step("ultimo",()=>session.ultimo(auth,context.client.ptoVta)):undefined;
  if(!auth||!active)report.steps.push({operation:"ultimo",status:"skipped"});
  if(last!==undefined&&(!Number.isSafeInteger(last)||last<0||last>=99999999))block("Invalid last authorized number");
  // The independent catalog must run even when PV/ultimo were blocked.
  const types=auth?await step("types",()=>session.types(auth)):undefined;
  if(!auth)report.steps.push({operation:"types",status:"skipped"});
  const today=(options.expected?.fechaEmision??new Date().toISOString().slice(0,10)).replaceAll("-","");
  if(!types?.some(t=>t.id===11&&t.validFrom<=today&&(t.validTo===null||t.validTo>=today)))block("Invoice type 11 is not currently available");
  for(const reserved of context.reservations){
   // Even 602/absence never authorizes recycling, repair or issuance.
   block("Existing reservation requires manual reconciliation; no automatic reuse");
   if(auth&&reserved.trustworthy)await step("consult-reservation",()=>session.consult(auth,reserved.request));
   else report.steps.push({operation:"consult-reservation",status:"skipped"});
  }
  if(!options.emitOnce)return report;
  if(!context.migrationReady)block("Migration 0008 and durable one-shot prerequisites are missing");
  const expected=options.expected;
  if(!expected||!options.invoiceId||expected.cuit!==context.client.cuit||expected.ptoVta!==context.client.ptoVta||expected.cbteTipo!==11||expected.cbteNro!==((last??-1)+1)||expected.importeIva!==0||expected.importeNeto!==expected.importeTotal||!Number.isSafeInteger(expected.importeTotal)||expected.importeTotal<=0||!/^\d{4}-\d{2}-\d{2}$/.test(expected.fechaEmision))block("Explicit whole expected tuple/amount/date authorization does not match the preflight");
  if(report.blockers.length||!auth||!expected||!options.invoiceId)return report;
  const claimed=await step("one-shot-claim",async()=>{await session.beginOnce(options.invoiceId!,expected);return true;});
  if(!claimed)return report;
  let result:IssueInvoiceResult|undefined;
  try{result=await session.issue(auth,expected);report.steps.push({operation:"issue-once",status:"ok"});}
  catch(error){
   report.steps.push({operation:"issue-once",status:"blocked",diagnostic:diagnostic(error)});block("Issuance uncertain/rejected; never resend without explicit authorization");
   // One read-only query of the same tuple; never a second FECAESolicitar or TA refresh.
   if (!(error instanceof ArcaError && error.category === "provider-errors" && !["10015","10016"].includes(error.code ?? ""))) result=await step("post-issue-consult",async()=>await session.consult(auth,expected)??undefined);
  }
  if(result&&/^\d{14}$/.test(result.cae)&&!/^0+$/.test(result.cae)&&result.cbteNro===expected.cbteNro&&/^\d{4}-\d{2}-\d{2}$/.test(result.caeFchVto)){
   const complete=await step("persist-authorization",async()=>{await session.complete(options.invoiceId!,expected,result!);return true;});
   if(complete){report.emitted=true;report.authorization=result;}
  }
  return report;
 }finally{await session.close();}
}
