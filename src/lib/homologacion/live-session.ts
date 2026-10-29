import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/types";
import { clients, credentials, diagnosticIssuance, invoices, issuedInvoices, taCache } from "@/lib/db/schema";
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
import { memoryOnlyTicketStore, type DiagnosticReservation, type DiagnosticSession } from "./diagnostic";

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
 const store=memoryOnlyTicketStore(async key=>{const [entry]=await db.select({token:taCache.token,sign:taCache.sign,issuedAt:taCache.issuedAtMs,expiresAt:taCache.expiresAtMs}).from(taCache).where(eq(taCache.service,key));return entry??null;});
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
  beginOnce:async(invoiceId,request)=>{
   if(!migrationReady||claimed)throw Error("Durable one-shot prerequisites missing or already claimed");
   const key=seriesKey("homologacion",request.cuit,request.ptoVta,request.cbteTipo),owner=randomUUID();
   if(!await acquireSeriesClaim(db,key,owner))throw Error("Series is claimed/uncertain; manual reconciliation required");
   try{
    if(!sessionAuth)throw Error("Preflight authentication required");
    const currentLast=await wsfe.ultimoAutorizado(sessionAuth,{ptoVta:request.ptoVta,cbteTipo:request.cbteTipo});
    if(currentLast+1!==request.cbteNro)throw Error("ARCA sequence changed since authorization; no issuance");
    let reservationId="";
    await db.transaction(async tx=>{
     const current=await loadInvoiceContext(tx as unknown as Db,invoiceId);
     assertRowEmittable(current.row.status);
     const actual=buildFecaReq(current.invoice,current.client,request.cbteNro);
     if(current.invoice.status!=="APPROVED"||current.client.id!==clientId||current.client.condicionIva!=="exento"||actual.cbteTipo!==11||!sameRequest(request,actual)||!current.invoice.approvalSnapshot||!matchesApprovalSnapshot(current.invoice.approvalSnapshot,createApprovalSnapshot(current.row,current.client,"homologacion")))throw Error("Approved invoice does not match whole explicit authorization");
     const heads=await tx.select({id:issuedInvoices.id}).from(issuedInvoices).where(and(eq(issuedInvoices.cuit,request.cuit),eq(issuedInvoices.ptoVta,request.ptoVta),eq(issuedInvoices.cbteTipo,request.cbteTipo),or(eq(issuedInvoices.environment,"homologacion"),isNull(issuedInvoices.environment)),or(isNull(issuedInvoices.cae),isNull(issuedInvoices.environment))));
     if(heads.length)throw Error("Existing reserved/unknown head blocks issuance");
     const tupleKey=JSON.stringify(["homologacion",request.cuit,request.ptoVta,request.cbteTipo,request.cbteNro]);
     await tx.insert(diagnosticIssuance).values({tupleKey,authorizationHash:createHash("sha256").update(JSON.stringify(actual)).digest("hex")});
     const [reserved]=await tx.insert(issuedInvoices).values({environment:"homologacion",invoiceId,cuit:request.cuit,ptoVta:request.ptoVta,cbteTipo:request.cbteTipo,cbteNro:request.cbteNro,importeTotalCentavos:request.importeTotal}).returning();
     reservationId=reserved!.id;
     await tx.update(invoices).set({status:"EMITTING"}).where(eq(invoices.id,invoiceId));
    });
    claimed={key,owner,invoiceId,request,reservationId,dispatched:false};
   }catch{await finishSeriesClaim(db,key,owner,false);throw Error("One-shot claim blocked; no issuance occurred");}
  },
  issue:async(auth,request)=>{
   if(!claimed||!sameRequest(request,claimed.request))throw Error("Durable marker required");
   // Consume in-process dispatch permission BEFORE sending, including synchronous errors.
   if(claimed.dispatched)throw Error("Second issue prohibited");
   claimed.dispatched=true;
   if(!await ownsSeriesClaim(db,claimed.key,claimed.owner))throw Error("Dispatch claim lost/expired; consult first");
   const result=await wsfe.solicitar(auth,fecaReqToSolicitar(request));
   if(result.resultado!=="A"||!result.cae||!result.caeFchVto||result.cbteNro!==request.cbteNro){
    const code=result.errors[0]?.code??result.observaciones[0]?.code;
    throw new ArcaBusinessError("ARCA rejected diagnostic emission",{code,stage:"issuance",category:"provider-errors",providerCodes:[...result.errors,...result.observaciones].filter(x=>/^\d{1,9}$/.test(x.code)).map(x=>Number(x.code))});
   }
   return {cae:result.cae,caeFchVto:result.caeFchVto,cbteNro:result.cbteNro};
  },
  complete:async(invoiceId,request,result)=>{
   if(!claimed||claimed.invoiceId!==invoiceId||!sameRequest(request,claimed.request)||result.cbteNro!==request.cbteNro)throw Error("Authorization mismatch");
   await db.transaction(async tx=>{
    await tx.update(issuedInvoices).set({cae:result.cae,caeFchVto:result.caeFchVto}).where(eq(issuedInvoices.id,claimed!.reservationId));
    await tx.update(invoices).set({status:"EMITTED"}).where(eq(invoices.id,invoiceId));
    await finishSeriesClaim(tx as unknown as Db,claimed!.key,claimed!.owner,true);
   });
   if(options.onAuthorized)try{await options.onAuthorized(request,result);}catch{(options.write??console.log)("Authorization persisted; PDF generation failed. Do not reissue.");}
  },
  close:async()=>{if(claimed)await finishSeriesClaim(db,claimed.key,claimed.owner,false);secrets.fill("");keyPem="";},
 };
}
