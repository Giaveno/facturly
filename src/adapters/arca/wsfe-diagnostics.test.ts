import { describe, expect, it } from "vitest";
import { WsfeClient } from "./wsfe";
import { parseDummyResponse, parseTiposCbteResponse } from "./wsfe-diagnostics";
const soap = (op: string, inner: string) => `<Envelope><Body><${op}Response><${op}Result>${inner}</${op}Result></${op}Response></Body></Envelope>`;
describe("documented read-only WSFE operations", () => {
  it("sends FEDummy without Auth and exact quoted action; catalog uses Auth", async () => {
    const calls: {body:string;action:string}[] = [];
    const client = new WsfeClient({url:"offline",transport:{post:async (_url,body,headers)=>{
      calls.push({body,action:headers.SOAPAction!});
      return body.includes("FEDummy") ? soap("FEDummy", "<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>") : soap("FEParamGetTiposCbte", "<ResultGet><CbteTipo><Id>11</Id><Desc>Factura C</Desc><FchDesde>20100901</FchDesde><FchHasta>NULL</FchHasta></CbteTipo></ResultGet>");
    }}});
    expect(await client.dummy()).toEqual({appServer:"OK",dbServer:"OK",authServer:"OK"});
    expect(calls[0]!.body).not.toContain("Auth"); expect(calls[0]!.action).toBe('"http://ar.gov.afip.dif.FEV1/FEDummy"');
    expect(await client.getTiposCbte({token:"fake",sign:"fake",cuit:"20123456786"})).toContainEqual({id:11,description:"Factura C",validFrom:"20100901",validTo:null});
    expect(calls[1]!.body).toContain("<ar:Auth>");
  });
  it("fails closed on unknown dummy state and preserves provider codes for catalogs", () => {
    expect(()=>parseDummyResponse(soap("FEDummy", "<AppServer>unexpected</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>"))).toThrow();
    try { parseTiposCbteResponse(soap("FEParamGetTiposCbte", "<Errors><Err><Code>602</Code><Msg>no</Msg></Err></Errors>")); throw Error("unreachable"); }
    catch (error) { expect(error).toMatchObject({diagnostic:{providerCodes:[602]}}); }
  });
  it.each(["<x/>","<Envelope><Body/>","<!DOCTYPE x><x/>"])("rejects malformed catalog evidence", xml => expect(()=>parseTiposCbteResponse(xml)).toThrow());
});
