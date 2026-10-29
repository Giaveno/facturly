import { describe, expect, it, vi } from "vitest";
import { PadronA5Client } from "./padron";
import { buildFecaesolicitarEnvelope, fecaReqToSolicitar } from "./wsfe";
import type { FECAEReq } from "@/ports/arca-gateway";
const persona = (taxes:string) => `<Envelope><Body><getPersona_v2Response><personaReturn><datosGenerales><idPersona>30710145764</idPersona></datosGenerales>${taxes}</personaReturn></getPersona_v2Response></Body></Envelope>`;
describe("recipient fiscal boundaries",()=>{
 it("uses strict v2 active-tax evidence, never regimenGeneral presence or tax33 as exento",async()=>{
  const post=vi.fn().mockResolvedValueOnce(persona("<datosRegimenGeneral/>")).mockResolvedValueOnce(persona("<datosRegimenGeneral><impuesto><idImpuesto>33</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral>")).mockResolvedValueOnce(persona("<datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral>"));
  const padron=new PadronA5Client({url:"https://offline.invalid",transport:{post}});
  expect(await padron.getPersona("token","sign","20123456786","30710145764")).toBe("unresolved");
  expect(await padron.getPersona("token","sign","20123456786","30710145764")).toBe("unresolved");
  expect(await padron.getPersona("token","sign","20123456786","30710145764")).toBe("ri");
  expect(post.mock.calls[0]![1]).toContain("getPersona_v2");
 });
 const request:FECAEReq={cuit:"20123456786",ptoVta:1,cbteTipo:11,cbteNro:1,receptorDocTipo:99,receptorDocNro:0,condicionIvaReceptorId:5,receptorRazonSocial:"Consumidor Final",fechaEmision:"2026-10-28",fechaVto:"2026-10-28",moneda:"PES",cotizacion:1,importeNeto:12100,importeIva:0,importeTotal:12100};
 it("omits the Iva element entirely for C (ARCA10071)",()=>{
  expect(buildFecaesolicitarEnvelope({token:"t",sign:"s",cuit:request.cuit},fecaReqToSolicitar(request))).not.toContain("<ar:Iva>");
 });
 it("maps explicitly selected B rate to ARCA alicuota and preserves products-only scope",()=>{
  const mapped=fecaReqToSolicitar({...request,cbteTipo:6,importeNeto:10000,importeIva:1050,importeTotal:11050,taxRate:10.5});
  expect(mapped.concepto).toBe(1);expect(mapped.iva).toEqual([{id:4,baseImpCentavos:10000,importeCentavos:1050}]);
 });
 it("rejects fabricated B IVA totals or missing rate and never includes IVA on C",()=>{
  expect(()=>fecaReqToSolicitar({...request,cbteTipo:6})).toThrow(/rate/);
  expect(()=>fecaReqToSolicitar({...request,cbteTipo:6,taxRate:21})).toThrow(/amounts/);
  expect(()=>fecaReqToSolicitar({...request,importeIva:2100})).toThrow(/cannot include IVA/);
  expect(fecaReqToSolicitar({...request,cbteTipo:6,taxRate:21,importeTotal:1,importeNeto:1})).toMatchObject({iva:[{id:5,baseImpCentavos:1,importeCentavos:0}]});
 });
});
