import { describe, expect, it, vi } from "vitest";
import { buildFeParamGetPtosVentaEnvelope, parseFeParamGetPtosVentaResponse, WsfeClient } from "./wsfe";

const response = (content: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><FEParamGetPtosVentaResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FEParamGetPtosVentaResult>${content}</FEParamGetPtosVentaResult></FEParamGetPtosVentaResponse></s:Body></s:Envelope>`;
const point = (nro = "12345", emission = "CAE", blocked = "N", date = "") => `<PtoVenta><Nro>${nro}</Nro><EmisionTipo>${emission}</EmisionTipo><Bloqueado>${blocked}</Bloqueado>${date}</PtoVenta>`;
describe("FEParamGetPtosVenta read-only protocol", () => {
  it("builds only the authenticated query and uses its SOAPAction", async () => {
    const auth = { token: "token<&", sign: "sign<&", cuit: "30710145764" };
    const xml = buildFeParamGetPtosVentaEnvelope(auth);
    expect(xml).toContain("<ar:FEParamGetPtosVenta>"); expect(xml).toContain("token&lt;&amp;");
    expect(xml).not.toMatch(/FECAESolicitar|PtoVta|CbteTipo/);
    const transport = { post: vi.fn(async () => response("")) };
    expect(await new WsfeClient({ url: "trusted", transport }).getPointsOfSale(auth)).toEqual([]);
    expect(transport.post).toHaveBeenCalledWith("trusted", xml, expect.objectContaining({ SOAPAction: '"http://ar.gov.afip.dif.FEV1/FEParamGetPtosVenta"' }));
  });
  it("parses singleton, multiple and no points without losing five-digit numbers", () => {
    expect(parseFeParamGetPtosVentaResponse(response(`<ResultGet>${point()}</ResultGet>`))).toEqual([{ number: 12345, emissionType: "CAE", blocked: false, deregisteredOn: null, status: "available" }]);
    const result = parseFeParamGetPtosVentaResponse(response(`<ResultGet>${point("1", "CAE", "S")}${point("2", "CAEA")}${point("99998", "CAE", "N", "<FchBaja>20261028</FchBaja>")}</ResultGet>`));
    expect(result.map(p => p.status)).toEqual(["blocked", "available", "deregistered"]);
    expect(result[2]?.deregisteredOn).toBe("2026-10-28");
    for (const empty of ["", "<ResultGet/>", "<ResultGet></ResultGet>"]) expect(parseFeParamGetPtosVentaResponse(response(empty))).toEqual([]);
  });
  it.each([
    point("1", "unknown"), point("1", "CAE", "?"), point("1", "CAE", ""),
    point("1", "CAE", "N", "<FchBaja>00000000</FchBaja>"), point("1", "CAE", "N", "<FchBaja>20260230</FchBaja>"),
  ])("never marks unknown flags or malformed dates available: %s", value => {
    expect(parseFeParamGetPtosVentaResponse(response(`<ResultGet>${value}</ResultGet>`))[0]?.status).toBe("unknown");
  });
  it.each(["<bad>", "<Envelope><Body><Fault><faultstring>SECRET</faultstring></Fault></Body></Envelope>", response("<Errors><Err><Code>1</Code><Msg>SECRET</Msg></Err></Errors>"), response(`<ResultGet>${point("0")}</ResultGet>`), response(`<ResultGet>${point("1.2")}</ResultGet>`), response(`<ResultGet>${point("100000")}</ResultGet>`), response(`<ResultGet>${point("1")}${point("1")}</ResultGet>`), response("<ResultGet><other>SECRET</other></ResultGet>")])("rejects malformed and provider error responses without remote text", xml => {
    expect(() => parseFeParamGetPtosVentaResponse(xml)).toThrow("ARCA query failed");
    try { parseFeParamGetPtosVentaResponse(xml); } catch (error) { expect(String(error)).not.toContain("SECRET"); }
  });
});
