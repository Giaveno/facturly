import { ArcaBusinessError } from "@/adapters/arca/errors";
import { describe, expect, it, vi } from "vitest";
import { runDiagnostic, type DiagnosticSession } from "./diagnostic";
import type { FECAEReq } from "@/ports/arca-gateway";
const request: FECAEReq = {cuit:"20123456786",ptoVta:3,cbteTipo:11,cbteNro:1,receptorDocTipo:99,receptorDocNro:0,condicionIvaReceptorId:5,receptorRazonSocial:"Consumidor Final",fechaEmision:"2026-10-28",fechaVto:"2026-10-28",moneda:"PES",cotizacion:1,importeNeto:625000,importeIva:0,importeTotal:625000,taxRate:null};
function setup() {
 const calls: string[]=[];
 const session: DiagnosticSession={
  context:{client:{id:"client",cuit:request.cuit,ptoVta:3,condition:"exento"},certificateCuit:request.cuit,credentialsValid:true,migrationReady:true,reservations:[]},
  dummy:async()=>{calls.push("dummy");},auth:async()=>{calls.push("auth");return {token:"fake",sign:"fake",cuit:request.cuit};},
  points:async()=>{calls.push("points");return [{number:3,emissionType:"CAE",blocked:false,deregisteredOn:null,status:"available"}];},
  ultimo:async()=>{calls.push("ultimo");return 0;},types:async()=>{calls.push("types");return [{id:11,description:"Factura C",validFrom:"20100901",validTo:null}];},
  consult:async()=>{calls.push("consult");return null;},
  beginOnce:async()=>{calls.push("claim");},issue:async()=>{calls.push("issue");return {cae:"70000000000001",caeFchVto:"2026-11-07",cbteNro:1};},complete:async()=>{calls.push("complete");},close:async()=>{},
 };
 const open=vi.fn(async()=>session);return {session,calls,open};
}
describe("homologacion one-shot diagnostic",()=>{
 it("auth-only performs exactly one authentication with no unrelated probes, emission, or tax-condition gate",async()=>{
  const s=setup();s.session.context.client.condition="monotributista";s.session.context.reservations=[{invoiceId:"old",request,trustworthy:true}];
  const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",authOnly:true});
  expect(s.calls).toEqual(["auth"]);expect(report.steps).toEqual([{operation:"auth",status:"ok"}]);expect(report.blockers).toEqual([]);expect(report.emitted).toBe(false);
 });
 it("auth-only faults use WSAA stage and never expose exception text or resend",async()=>{
  const s=setup();s.session.auth=async()=>{s.calls.push("auth");throw new ArcaBusinessError("SECRET fault",{category:"soap-fault",httpStatus:500});};
  const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",authOnly:true});
  expect(s.calls).toEqual(["auth"]);expect(report.steps).toEqual([{operation:"auth",status:"blocked",diagnostic:{stage:"wsaa",category:"soap-fault",httpStatus:500}}]);expect(JSON.stringify(report)).not.toContain("SECRET");
 });
 it("auth-only cannot combine with issuance and fails before opening credentials",async()=>{
  const s=setup();await expect(runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",authOnly:true,emitOnce:true})).rejects.toThrow("auth-only");expect(s.open).not.toHaveBeenCalled();
 });
 it("guards exact environment before opening DB, credentials or network",async()=>{
  const s=setup();for(const environment of [undefined,"production"," homologacion "]) await expect(runDiagnostic({environment,open:s.open},{clientId:"client"})).rejects.toThrow("homologacion");
  expect(s.open).not.toHaveBeenCalled();
 });
 it("defaults to ordered read-only probes without claiming or issuing",async()=>{
  const s=setup();const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client"});
  expect(s.calls).toEqual(["dummy","auth","points","ultimo","types"]);expect(report.emitted).toBe(false);
 });
 it("reports ultimo skipped but still runs independent types catalog after PV 602",async()=>{
  const s=setup();s.session.points=async()=>{s.calls.push("points");throw Error("SECRET");};
  const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"});
  expect(s.calls).toEqual(["dummy","auth","points","types"]);expect(report.steps.find(s=>s.operation==="ultimo")?.status).toBe("skipped");expect(JSON.stringify(report)).not.toContain("SECRET");
 });
 it.each(["mismatch","no-points","wrong-pv","no-types","old-head","missing-migration"])("does not issue when gated by %s",async kind=>{
  const s=setup();
  if(kind==="mismatch")s.session.context.client.condition="monotributista";
  if(kind==="no-points")s.session.points=async()=>[];
  if(kind==="wrong-pv")s.session.context.client.ptoVta=1;
  if(kind==="no-types")s.session.types=async()=>[];
  if(kind==="old-head")s.session.context.reservations=[{invoiceId:"old",request,trustworthy:true}];
  if(kind==="missing-migration")s.session.context.migrationReady=false;
  const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"});
  expect(report.emitted).toBe(false);expect(s.calls).not.toContain("issue");expect(s.calls).not.toContain("claim");
 });
 it("allows exactly one issue only with matching whole authorization and durable marker",async()=>{
  const s=setup();expect((await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"})).emitted).toBe(true);
  expect(s.calls).toEqual(["dummy","auth","points","ultimo","types","claim","issue","complete"]);
 });
 it("consults once after unknown outcome, never refreshes auth, loops or sends again",async()=>{
  const s=setup();s.session.issue=async()=>{s.calls.push("issue");throw Error("SECRET timeout");};
  const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"});
  expect(s.calls.filter(x=>x==="issue")).toHaveLength(1);expect(s.calls.filter(x=>x==="consult")).toHaveLength(1);expect(s.calls.filter(x=>x==="auth")).toHaveLength(1);expect(s.calls).not.toContain("complete");expect(report.emitted).toBe(false);
 });
 it("fails closed if one-shot marker already exists",async()=>{
  const s=setup();s.session.beginOnce=async()=>{throw Error("existing marker");};
  expect((await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"})).emitted).toBe(false);expect(s.calls).not.toContain("issue");
 });
});

it("stops on an explicit rejection without consulting or inventing a PDF/CAE", async()=> {
 const s=setup();s.session.issue=async()=>{s.calls.push("issue");throw new ArcaBusinessError("rejection",{code:"10049",category:"provider-errors"});};
 const report=await runDiagnostic({environment:"homologacion",open:s.open},{clientId:"client",emitOnce:true,expected:request,invoiceId:"invoice"});
 expect(report.emitted).toBe(false);expect(report.authorization).toBeUndefined();expect(s.calls).not.toContain("consult");expect(s.calls).not.toContain("complete");
});
