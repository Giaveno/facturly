import { describe, expect, it } from "vitest";
import { parseFecaesolicitarResponse, parseFecompConsultarResponse, WsfeClient } from "./wsfe";
export const consultedXml = (detail = "") => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><FECompConsultarResponse><FECompConsultarResult>${detail}</FECompConsultarResult></FECompConsultarResponse></s:Body></s:Envelope>`;
export const authorizedDetail = `<ResultGet><Resultado>A</Resultado><EmisionTipo>CAE</EmisionTipo><CodAutorizacion>70212345678901</CodAutorizacion><FchVto>20261107</FchVto><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20261028</CbteFch><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo><DocTipo>99</DocTipo><DocNro>0</DocNro><ImpTotal>100.00</ImpTotal><ImpNeto>100.00</ImpNeto><ImpIVA>0.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet>`;
describe("strict fiscal response boundaries", () => {
    it.each(["", "<Envelope/>", consultedXml(), consultedXml(authorizedDetail + authorizedDetail), consultedXml(authorizedDetail).slice(0, -4), '<!DOCTYPE a><Envelope/>'])('never manufactures a rejection/CAE from invalid XML (%s)', xml => {
        expect(() => parseFecompConsultarResponse(xml)).toThrow();
        expect(() => parseFecaesolicitarResponse(xml)).toThrow();
    });
    it("returns only numeric codes and fixed provider messages", () => {
        expect(() => parseFecompConsultarResponse(consultedXml('<Errors><Err><Code>602</Code><Msg>SECRET_TOKEN</Msg></Err></Errors>'))).toThrow(expect.objectContaining({ diagnostic: { stage: "wsfe", category: "provider-errors", providerCodes: [602] } }));
    });
    it("validates query authorization without numeric coercion", () => {
        expect(parseFecompConsultarResponse(consultedXml(authorizedDetail))).toMatchObject({ resultado: "A", cae: "70212345678901", cbteNro: 7, emissionType: "CAE", ptoVta: 1, cbteTipo: 11, impTotalCentavos: 10000, docNro: 0 });
        for (const value of ["oops", "123", "70212345678901SECRET"])
            expect(() => parseFecompConsultarResponse(consultedXml(authorizedDetail.replace("70212345678901", value)))).toThrow();
        expect(() => parseFecompConsultarResponse(consultedXml(authorizedDetail.replace("20261107", "20260230")))).toThrow();
        expect(() => parseFecompConsultarResponse(consultedXml(authorizedDetail.replace("<CbteDesde>7", "<CbteDesde>0")))).toThrow();
        expect(() => parseFecompConsultarResponse(consultedXml(authorizedDetail.replace("<Resultado>A</Resultado>", "<Resultado>A</Resultado><Resultado>R</Resultado>")))).toThrow();
    });
    it("sets official quoted SOAPActions for issuance and query", async () => {
        const actions: string[] = [];
        const client = new WsfeClient({ url: "offline", transport: { async post(_url, _body, headers) { actions.push(headers.SOAPAction!); return "<Envelope/>"; } } });
        await client.consultarComprobante({ token: "T", sign: "S", cuit: "30710145764" }, { ptoVta: 1, cbteTipo: 11, cbteNro: 7 }).catch(() => { });
        expect(actions).toEqual(['"http://ar.gov.afip.dif.FEV1/FECompConsultar"']);
    });
});
