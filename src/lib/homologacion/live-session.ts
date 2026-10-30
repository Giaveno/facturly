import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/types";
import { clients, credentials, diagnosticIssuance, invoices, issuedInvoices } from "@/lib/db/schema";
import { DrizzleTaCacheStore } from "@/lib/db/ta-cache-store";
import { decryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { assertKeyMatchesCertificate, inspectCertificate } from "@/lib/credentials/pem";
import { createCredentialTaCache } from "@/adapters/arca/credential-ta-cache";
import { WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { createFetchTransport } from "@/adapters/arca/http";
import { HOMOLOGACION_CALL_MS } from "@/adapters/arca/timeouts";
import { createHomologacionCapture } from "@/adapters/arca/soap-diagnostics";
import { WsfeClient, fecaReqToSolicitar, type WsfeAuth, type FecompConsultarResult } from "@/adapters/arca/wsfe";
import { ArcaBusinessError } from "@/adapters/arca/errors";
import { ArcaQueryError } from "@/adapters/arca/query-diagnostics";
import { buildFecaReq } from "@/lib/emission/emission-service";
import { acquireSeriesClaim, finishSeriesClaim, ownsSeriesClaim, seriesKey } from "@/lib/emission/series-claim";
import { loadReservedInvoice } from "@/lib/invoices/reconciliation";
import { loadInvoiceContext } from "@/lib/review/workflow";
import { createApprovalSnapshot, matchesApprovalSnapshot, parseApprovalSnapshot } from "@/domain/approval-snapshot";
import { assertRowEmittable } from "@/domain/emission";
import type { FECAEReq, IssueInvoiceResult } from "@/ports/arca-gateway";
import { type DiagnosticReservation, type DiagnosticSession } from "./diagnostic";

function sameRequest(a:FECAEReq,b:FECAEReq):boolean {
 return (Object.keys(b) as (keyof FECAEReq)[]).every(key=>key==="taxRate"?(a[key]??null)===(b[key]??null):a[key]===b[key]);
}
/** A read-only result is trusted only when every fiscal field matches the expected tuple. */
export function matchConsultation(request:FECAEReq,e:FecompConsultarResult):IssueInvoiceResult|null {
 const pairs=[[e.cbteNro,request.cbteNro],[e.ptoVta,request.ptoVta],[e.cbteTipo,request.cbteTipo],[e.impTotalCentavos,request.importeTotal],[e.impNetoCentavos,request.importeNeto],[e.impIvaCentavos,request.importeIva],[e.moneda,request.moneda],[e.cotizacion,request.cotizacion],[e.docTipo,request.receptorDocTipo],[e.docNro,request.receptorDocNro],[e.fechaEmision,request.fechaEmision.replaceAll("-","")]];
 if(e.resultado!=="A"||e.emissionType!=="CAE"||!e.cae||!e.caeFchVto||pairs.some(([a,b])=>a==null||a!==b)||(e.condicionIvaReceptorId!=null&&e.condicionIvaReceptorId!==request.condicionIvaReceptorId)||(e.concepto!=null&&e.concepto!==1)||[e.impTotConcCentavos,e.impOpExCentavos,e.impTribCentavos].some(x=>x!=null&&x!==0))return null;
 return {cae:e.cae,caeFchVto:e.caeFchVto,cbteNro:request.cbteNro};
}
/** Does not migrate or select new reservation fields during preflight on an old schema. */
export async function createDiagnosticSession(db:Db,env:Record<string,string|undefined>,clientId:string,options:{authOnly?:boolean;debug?:boolean;fetchFn?:typeof fetch;write?:(text:string)=>void;onAuthorized?:(request:FECAEReq,result:IssueInvoiceResult)=>Promise<void>}={}):Promise<DiagnosticSession> {
 if(env.ARCA_ENV!=="homologacion")throw Error("ARCA_ENV must be exactly homologacion");
 const [client]=await db.select({id:clients.id,cuit:clients.cuit,ptoVta:clients.ptoVta,condition:clients.condicionIva}).from(clients).where(eq(clients.id,clientId));
 if(!client)throw Error("Existing client not found");
 const migration=options.authOnly?undefined:await db.execute(sql`SELECT to_regclass('public.emission_series_claims') IS NOT NULL AND to_regclass('public.diagnostic_issuance') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='issued_invoices' AND column_name='environment') AS ready`);
 const migrationReady=migration?.rows[0]?.ready===true;
 const [stored]=await db.select({certPem:credentials.certPem,keyCiphertext:credentials.keyCiphertext,iv:credentials.iv,authTag:credentials.authTag}).from(credentials).limit(1);
 let certificateCuit:string|null=null,credentialsValid=false,keyPem="";
 if(stored)try{
  const cert=inspectCertificate(stored.certPem);certificateCuit=cert.cuit;
  if(Date.parse(cert.notBefore)>Date.now()||Date.parse(cert.notAfter)<=Date.now())throw Error("Expired certificate");
  keyPem=decryptPrivateKey({keyCiphertext:stored.keyCiphertext,iv:stored.iv,authTag:stored.authTag},deriveAesKey(env.AES_KEY??""));
  assertKeyMatchesCertificate(stored.certPem,keyPem);credentialsValid=true;
 }catch{/* Only categorical failure is reported; no exception cause, PEM or ciphertext output. */}
 const old=options.authOnly?[]:await db.select({invoiceId:issuedInvoices.invoiceId,cuit:issuedInvoices.cuit,ptoVta:issuedInvoices.ptoVta,cbteTipo:issuedInvoices.cbteTipo,cbteNro:issuedInvoices.cbteNro}).from(issuedInvoices).where(and(eq(issuedInvoices.cuit,client.cuit),isNull(issuedInvoices.cae)));
 const reservations:DiagnosticReservation[]=[];
 for(const reservation of old){
  const r=await loadReservedInvoice(db,reservation.invoiceId);if(!r)continue;
  let trustworthy=false;try{const a=parseApprovalSnapshot(r.approvalSnapshot);trustworthy=a.environment==="homologacion"&&a.issuerCuit===r.cuit&&a.ptoVta===r.ptoVta&&a.amount===r.importeTotalCentavos;}catch{}
  const request:FECAEReq={cuit:r.cuit,ptoVta:r.ptoVta,cbteTipo:r.cbteTipo as 1|6|11,cbteNro:r.cbteNro,receptorDocTipo:r.docTipo??0,receptorDocNro:r.docNro??0,condicionIvaReceptorId:r.condicionIvaReceptorId??0,receptorRazonSocial:"",fechaEmision:r.fechaEmision??"",fechaVto:r.fechaEmision??"",moneda:r.moneda??"",cotizacion:r.cotizacion??0,importeNeto:r.net??0,importeIva:r.iva??0,importeTotal:r.total??0};
  reservations.push({invoiceId:r.invoiceId,request,trustworthy});
 }
 const secrets:string[]=[stored?.certPem??"",keyPem];
 const capture=createHomologacionCapture({environment:env.ARCA_ENV,enabled:options.debug===true,secrets:()=>secrets,write:options.write??console.log});
 const signal=AbortSignal.timeout(240_000);
 const transport=createFetchTransport({timeoutMs:HOMOLOGACION_CALL_MS,capture,fetchFn:async(url,init)=>{
  if(typeof url!=="string"||![WSAA_HOMOLOGACION_URL,WSFE_HOMOLOGACION_URL].includes(url))throw Error("Endpoint refused");
  signal.throwIfAborted();
  const response=await (options.fetchFn??fetch)(url,{...init,redirect:"error",cache:"no-store",signal:AbortSignal.any([signal,init?.signal??AbortSignal.timeout(HOMOLOGACION_CALL_MS)])});
  if(Number(response.headers.get("content-length"))>1_048_576)throw Error("Response too large");
  if(!response.body)return response;
  let bytes=0;
  const limited=new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>1_048_576)throw Error("Response too large");controller.enqueue(chunk);}});
  return new Response(response.body.pipeThrough(limited),{status:response.status,headers:response.headers});
 }});
 const wsfe=new WsfeClient({url:WSFE_HOMOLOGACION_URL,transport});
 const store=new DrizzleTaCacheStore(db);
 let sessionAuth: WsfeAuth | undefined;
 let claimed:{key:string;owner:string;invoiceId:string;request:FECAEReq;reservationId:string;dispatched:boolean}|undefined;
 return {
  context:{client,certificateCuit,credentialsValid,migrationReady,reservations},
  dummy:async()=>{await wsfe.dummy();},
  auth:async()=>{
   if(!credentialsValid||!stored||certificateCuit!==client.cuit)throw Error("Credential mismatch");
   const ta=await createCredentialTaCache({url:WSAA_HOMOLOGACION_URL,credentials:{certPem:stored.certPem,keyPem},transport,store}).get("wsfe");
   secrets.push(ta.token,ta.sign);sessionAuth={token:ta.token,sign:ta.sign,cuit:client.cuit};return sessionAuth;
  },
  points:auth=>wsfe.getPointsOfSale(auth),ultimo:(auth,ptoVta)=>wsfe.ultimoAutorizado(auth,{ptoVta,cbteTipo:11}),types:auth=>wsfe.getTiposCbte(auth),
  consult:async(auth,request)=>{try{return matchConsultation(request,await wsfe.consultarComprobante(auth,{ptoVta:request.ptoVta,cbteTipo:request.cbteTipo,cbteNro:request.cbteNro}));}catch(error){if(error instanceof ArcaQueryError&&error.diagnostic.category==="provider-errors"&&error.diagnostic.providerCodes?.length===1&&error.diagnostic.providerCodes[0]===602)return null;throw error;}},
  beginOnce:async()=>{throw Error("Diagnostic issuance retired; use emitComprobante");},
  issue:async()=>{throw Error("Diagnostic issuance retired; use emitComprobante");},
  complete:async()=>{throw Error("Diagnostic issuance retired; use emitComprobante");},
  close:async()=>{if(claimed)await finishSeriesClaim(db,claimed.key,claimed.owner,false);secrets.fill("");keyPem="";},
 };
}
