import { describe, expect, it } from "vitest";
import { parseFecompUltimoAutorizadoResponse, WsfeClient } from "./wsfe";
import { ArcaAuthError, ArcaBusinessError, ArcaTransientError } from "./errors";

const result = (payload: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://ar.gov.afip.dif.FEV1/"><s:Body><a:FECompUltimoAutorizadoResponse><a:FECompUltimoAutorizadoResult>${payload}</a:FECompUltimoAutorizadoResult></a:FECompUltimoAutorizadoResponse></s:Body></s:Envelope>`;
const error = (code: string) => `<a:Err><a:Code>${code}</a:Code><a:Msg>SECRET_TOKEN_PRIVATE_KEY</a:Msg></a:Err>`;

describe("ultimo response safety", () => {
  it.each([0, 7, 99_999_999])("accepts explicit %i in a namespaced singleton result", number => {
    expect(parseFecompUltimoAutorizadoResponse(result(`<a:CbteNro>${number}</a:CbteNro>`))).toBe(number);
  });

  it.each(["602", "11002"])("rejects provider code %s without assuming a first number", code => {
    for (const number of ["", "<a:CbteNro>0</a:CbteNro>"]) {
      let failure: unknown;
      try { parseFecompUltimoAutorizadoResponse(result(`${number}<a:Errors>${error(code)}</a:Errors>`)); } catch (e) { failure = e; }
      expect(failure).toBeInstanceOf(ArcaBusinessError);
      expect(failure).toMatchObject({ code, stage: "ultimo", category: "provider-errors", providerCodes: [Number(code)] });
      expect(JSON.stringify(failure)).not.toContain("SECRET");
      expect(String(failure)).not.toContain("SECRET");
    }
  });

  it.each(["500", "501", "502"])("classifies infrastructure code %s as transient", code => {
    expect(() => parseFecompUltimoAutorizadoResponse(result(`<a:Errors>${error(code)}</a:Errors>`))).toThrow(ArcaTransientError);
  });
  it("keeps auth retry bounded through the existing typed taxonomy", () => {
    expect(() => parseFecompUltimoAutorizadoResponse(result(`<a:Errors>${error("600")}</a:Errors>`))).toThrow(ArcaAuthError);
  });
  it("bounds exposed provider codes and never copies non-numeric codes", () => {
    const codes = Array.from({ length: 25 }, (_, i) => error(String(11002 + i))).join("");
    try { parseFecompUltimoAutorizadoResponse(result(`<a:Errors>${codes}</a:Errors>`)); } catch (failure) {
      expect(failure).toMatchObject({ providerCodes: Array.from({ length: 10 }, (_, i) => 11002 + i) });
    }
    expect(() => parseFecompUltimoAutorizadoResponse(result(`<a:Errors>${error("SECRET_CODE")}</a:Errors>`))).toThrow(expect.objectContaining({ category: "malformed-response" }));
  });
  it("does not hide a permanent rejection behind an auth/infrastructure code", () => {
    expect(() => parseFecompUltimoAutorizadoResponse(result(`<a:CbteNro>8</a:CbteNro><a:Errors>${error("600")}${error("11002")}${error("500")}</a:Errors>`))).toThrow(ArcaBusinessError);
  });

  it.each(["", "<a:CbteNro/>", "<a:CbteNro>NaN</a:CbteNro>", "<a:CbteNro>-1</a:CbteNro>", "<a:CbteNro>1.5</a:CbteNro>", "<a:CbteNro>1e2</a:CbteNro>", "<a:CbteNro>100000000</a:CbteNro>", "<a:CbteNro>1</a:CbteNro><a:CbteNro>2</a:CbteNro>"])("rejects malformed or missing number: %s", payload => {
    expect(() => parseFecompUltimoAutorizadoResponse(result(payload))).toThrow(expect.objectContaining({ stage: "ultimo", category: "malformed-response" }));
  });
  it.each(["not xml SECRET", "<Envelope><Body>", result("<a:CbteNro>1</a:CbteNro>") + "<extra/>", `<!DOCTYPE x [<!ENTITY secret 'SECRET'>]>${result("<a:CbteNro>1</a:CbteNro>")}`])("fails closed for invalid XML", xml => {
    expect(() => parseFecompUltimoAutorizadoResponse(xml)).toThrow(expect.objectContaining({ stage: "ultimo", category: "malformed-response" }));
  });
  it.each(["Client", "Server"])("handles SOAP %s faults without exposing fault text", code => {
    const xml = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:${code}</faultcode><faultstring>SECRET_TOKEN</faultstring></s:Fault></s:Body></s:Envelope>`;
    expect(() => parseFecompUltimoAutorizadoResponse(xml)).toThrow(expect.objectContaining({ stage: "ultimo", category: "soap-fault", kind: code === "Server" ? "transient" : "business" }));
  });
  it("attaches a safe operation to transport failures without preserving raw causes", async () => {
    const wsfe = new WsfeClient({ url: "https://offline.invalid", transport: { post: async () => { throw new ArcaBusinessError("SECRET_TOKEN", { faultstring: "SECRET_KEY" }); } } });
    const failure = await wsfe.ultimoAutorizado({ token: "T", sign: "S", cuit: "C" }, { ptoVta: 1, cbteTipo: 11 }).catch(e => e);
    expect(failure).toMatchObject({ stage: "ultimo", kind: "business", category: "http" });
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    expect(String(failure)).not.toContain("SECRET");
  });
});
