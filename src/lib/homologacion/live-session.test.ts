import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "@/lib/db/schema";
import { createDiagnosticSession } from "./live-session";
import { runDiagnostic } from "./diagnostic";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import { encryptPrivateKey, deriveAesKey } from "@/lib/db/credentials";
import { WSAA_HOMOLOGACION_URL } from "@/adapters/arca/constants";
import { certificateFingerprint } from "@/adapters/arca/credential-ta-cache";
const soap=(op:string,value:string)=>`<Envelope><Body><${op}Response><${op}Result>${value}</${op}Result></${op}Response></Body></Envelope>`;
let raw:PGlite,db:ReturnType<typeof drizzle<typeof schema>>,clientId:string;
const AES="a".repeat(64);
beforeAll(async()=>{
 raw=new PGlite();
 for(const migration of readMigrationFiles({migrationsFolder:fileURLToPath(new URL("../../../drizzle",import.meta.url))}).slice(0,8))for(const sql of migration.sql)await raw.exec(sql);
 db=drizzle(raw,{schema});
 const [client]=await db.insert(schema.clients).values({cuit:"20123456786",razonSocial:"Offline test",ptoVta:3,condicionIva:"exento"}).returning();clientId=client!.id;
 const fixture=generateSelfSignedCert("20123456786");
 await db.insert(schema.credentials).values({certPem:fixture.certPem,...encryptPrivateKey(fixture.keyPem,deriveAesKey(AES))});
});

it("auth-only exposes a sanitized WSAA fault with one native HTTP call and no TA writes",async()=>{
 const writes:string[]=[];
 const fetchFn=vi.fn(async(url:URL|RequestInfo,init?:RequestInit)=>{
  expect(url).toBe(WSAA_HOMOLOGACION_URL);expect(String(init?.body)).toContain("loginCms");
  return new Response('<soap:Envelope xmlns:soap="urn:soap"><soap:Body><soap:Fault><faultcode>ns1:coe.alreadyAuthenticated</faultcode><faultstring>El CEE ya posee un TA valido</faultstring><detail>UNTRUSTED_PRIVATE_DETAIL</detail></soap:Fault></soap:Body></soap:Envelope>',{status:500,headers:{"content-type":"text/xml; charset=utf-8"}});
 });
 const report=await runDiagnostic({environment:"homologacion",open:id=>createDiagnosticSession(db,{ARCA_ENV:"homologacion",AES_KEY:AES},id,{authOnly:true,debug:true,fetchFn,write:x=>writes.push(x)})},{clientId,authOnly:true});
 expect(fetchFn).toHaveBeenCalledOnce();expect(report.steps).toEqual([{operation:"auth",status:"blocked",diagnostic:{stage:"wsaa",category:"soap-fault",httpStatus:500}}]);
 expect(writes.join("")).toContain('"faultcode":"ns1:coe.alreadyAuthenticated"');expect(writes.join("")).toContain('"faultstring":"El CEE ya posee un TA valido"');expect(writes.join("")).toContain('"httpStatus":500');
 expect(writes.join("")).not.toContain("UNTRUSTED_PRIVATE_DETAIL");expect(writes.join("")).not.toContain("<soap:Fault>");expect(await db.select().from(schema.taCache)).toEqual([]);
});

it("auth-only reuses a valid existing certificate/service/endpoint-scoped TA without calling WSAA or changing its row",async()=>{
 const [credential]=await db.select({certPem:schema.credentials.certPem}).from(schema.credentials);
 const entry={service:`${WSAA_HOMOLOGACION_URL}:${certificateFingerprint(credential!.certPem)}:wsfe`,token:"OFFLINE_CACHED_TOKEN",sign:"OFFLINE_CACHED_SIGN",issuedAtMs:Date.now()-1000,expiresAtMs:Date.now()+3600000};
 await db.insert(schema.taCache).values(entry);
 const before=await db.select().from(schema.taCache);const fetchFn=vi.fn(async()=>{throw Error("Must not call network");});const writes:string[]=[];
 const report=await runDiagnostic({environment:"homologacion",open:id=>createDiagnosticSession(db,{ARCA_ENV:"homologacion",AES_KEY:AES},id,{authOnly:true,debug:true,fetchFn,write:x=>writes.push(x)})},{clientId,authOnly:true});
 expect(report.steps).toEqual([{operation:"auth",status:"ok"}]);expect(fetchFn).not.toHaveBeenCalled();expect(await db.select().from(schema.taCache)).toEqual(before);expect(writes).toEqual([]);expect(report.emitted).toBe(false);
 await db.delete(schema.taCache);
});
afterAll(async()=>{await raw.close();});
it("runs real adapter preflight against pre-0008 schema, reports PV 602, still runs catalog, never writes a TA",async()=>{
 const operations:string[]=[];
 const fetchFn=vi.fn(async(_url:URL|RequestInfo,init?:RequestInit)=>{
  const body=String(init?.body??"");
  if(body.includes("loginCms")) {operations.push("wsaa");return new Response(`<Envelope><Body><loginCmsResponse><loginCmsReturn><![CDATA[<loginTicketResponse><header><expirationTime>${new Date(Date.now()+3600000).toISOString()}</expirationTime></header><credentials><token>OFFLINE_TOKEN</token><sign>OFFLINE_SIGN</sign></credentials></loginTicketResponse>]]></loginCmsReturn></loginCmsResponse></Body></Envelope>`);}
  if(body.includes("FEDummy")){operations.push("dummy");expect(body).not.toContain("Auth");return new Response(soap("FEDummy","<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>"));}
  if(body.includes("FEParamGetPtosVenta")){operations.push("points");return new Response(soap("FEParamGetPtosVenta","<Errors><Err><Code>602</Code><Msg>PV unavailable</Msg></Err></Errors>"));}
  if(body.includes("FEParamGetTiposCbte")){operations.push("types");return new Response(soap("FEParamGetTiposCbte","<ResultGet><CbteTipo><Id>11</Id><Desc>Factura C</Desc><FchDesde>20100901</FchDesde><FchHasta>NULL</FchHasta></CbteTipo></ResultGet>"));}
  throw Error("Unexpected operation");
 });
 const report=await runDiagnostic({environment:"homologacion",open:id=>createDiagnosticSession(db,{ARCA_ENV:"homologacion",AES_KEY:AES},id,{fetchFn})},{clientId});
 expect(report.migrationReady).toBe(false);expect(report.emitted).toBe(false);expect(operations).toEqual(["dummy","wsaa","points","types"]);
 expect(report.steps.find(s=>s.operation==="points")).toMatchObject({status:"blocked",diagnostic:{providerCodes:[602]}});
 expect(await db.select().from(schema.taCache)).toEqual([]);
 expect(fetchFn.mock.calls.every(([,init])=>init?.redirect==="error")).toBe(true);
});
