import { describe, expect, it } from "vitest";
import { buildPadronLookupEnvelope, parsePadronLookup } from "./padron-lookup";
import { PADRON_HOMOLOGACION_URL, PADRON_PRODUCTION_URL } from "./constants";

const cuit = "30710145764";
const wrap = (body: string) => `<Envelope><Body><getPersona_v2Response><personaReturn>${body}</personaReturn></getPersona_v2Response></Body></Envelope>`;
const general = `<datosGenerales><idPersona>${cuit}</idPersona><razonSocial>TEST SA</razonSocial></datosGenerales>`;
const tax = (id: string, state = "AC") => `<impuesto><idImpuesto>${id}</idImpuesto><estadoImpuesto>${state}</estadoImpuesto></impuesto>`;
describe("strict read-only Padrón lookup", () => {
  it("uses the ARCA v4.1 documented Padrón endpoints", () => {
    expect(PADRON_HOMOLOGACION_URL).toBe("https://awshomo.arca.gob.ar/sr-padron/webservices/personaServiceA5");
    expect(PADRON_PRODUCTION_URL).toBe("https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5");
  });
  it("matches the v4.1 request example and WSDL parameter order/namespaces", () => {
    expect(buildPadronLookupEnvelope({ token: "TOKEN", sign: "SIGN", cuitRepresentada: "20123456786" }, cuit)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">' +
      '<soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>TOKEN</token><sign>SIGN</sign>' +
      `<cuitRepresentada>20123456786</cuitRepresentada><idPersona>${cuit}</idPersona>` +
      '</a5:getPersona_v2></soapenv:Body></soapenv:Envelope>',
    );
  });
  it.each([["<detail><a5:SRValidationException xmlns:a5=\"http://a5.soap.ws.server.puc.sr/\"/></detail>", "validation-rejected"], ["", "unclassified"]])("exposes only a fixed SOAP Fault subtype", (detail, faultReason) => {
    try { parsePadronLookup(`<Envelope><Body><Fault><faultstring>SECRET_TOKEN PRIVATE</faultstring>${detail}</Fault></Body></Envelope>`, cuit); throw new Error("expected failure"); }
    catch (error) {
      expect(error).toMatchObject({ diagnostic: { stage: "padron", category: "soap-fault", faultReason } });
      expect(JSON.stringify(error)).not.toMatch(/SECRET|PRIVATE|faultstring/);
    }
  });
  it("uses documented v2 operation and escapes every auth/identity value", () => {
    const xml = buildPadronLookupEnvelope({ token: "TOKEN<&", sign: "SIGN<&", cuitRepresentada: "20123456786" }, cuit);
    expect(xml).toContain("<a5:getPersona_v2>"); expect(xml).toContain("<token>TOKEN&lt;&amp;</token>"); expect(xml).toContain("<sign>SIGN&lt;&amp;</sign>");
    expect(xml).toContain(`<idPersona>${cuit}</idPersona>`);
  });
  it.each([["30", "ri"], ["32", "exento"], ["20", "monotributista"]])("maps active tax %s from documented nested evidence", (id, condition) => {
    const section = id === "20" ? "datosMonotributo" : "datosRegimenGeneral";
    expect(parsePadronLookup(wrap(`${general}<${section}>${tax(id)}</${section}>`), cuit)).toEqual({ status: "found", condition, razonSocial: "TEST SA", reason: "explicit_tax" });
  });
  it.each(["33", "34", "10", "999"])('does not fabricate exempt/RI from tax %s or general block', id => {
    expect(parsePadronLookup(wrap(`${general}<datosRegimenGeneral>${tax(id)}</datosRegimenGeneral>`), cuit)).toMatchObject({ condition: "no-determinada", reason: "no_supported_tax" });
  });
  it("distinguishes no condition, inactive, unknown and mixed evidence", () => {
    expect(parsePadronLookup(wrap(general), cuit)).toMatchObject({ status: "found", reason: "no_supported_tax" });
    expect(parsePadronLookup(wrap(`${general}<datosRegimenGeneral>${tax("30", "BA")}</datosRegimenGeneral>`), cuit)).toMatchObject({ condition: "no-determinada" });
    for (const taxes of [tax("30", "???"), tax("30", ""), tax("30") + tax("32"), tax("30") + tax("33"), "<impuesto>30</impuesto>"]) {
      expect(parsePadronLookup(wrap(`${general}<datosRegimenGeneral>${taxes}</datosRegimenGeneral>`), cuit)).toMatchObject({ condition: "no-determinada", reason: "ambiguous_data" });
    }
    expect(parsePadronLookup(wrap(`${general}<datosMonotributo>${tax("20")}</datosMonotributo><datosRegimenGeneral>${tax("30")}</datosRegimenGeneral>`), cuit)).toMatchObject({ reason: "ambiguous_data" });
  });
  it("does not label an inactive or non-CUIT identity as current IVA evidence", () => {
    for (const field of ["<estadoClave>INACTIVO</estadoClave>", "<tipoClave>CUIL</tipoClave>"]) {
      expect(parsePadronLookup(wrap(general.replace("</datosGenerales>", `${field}</datosGenerales>`) + `<datosRegimenGeneral>${tax("30")}</datosRegimenGeneral>`), cuit)).toMatchObject({ condition: "no-determinada", reason: "ambiguous_data" });
    }
  });
  it("recognizes only the documented no-person error, never arbitrary provider messages", () => {
    expect(parsePadronLookup(wrap(`<errorConstancia><error>No existe persona con ese Id</error><idPersona>${cuit}</idPersona></errorConstancia>`), cuit)).toEqual({ status: "not_found", condition: "no-determinada", reason: "not_found" });
    for (const body of ["<errorConstancia><error>SECRET</error></errorConstancia>", "<errorMonotributo><error>SECRET</error></errorMonotributo>", `${general}<errorConstancia><error>No existe persona con ese Id</error></errorConstancia>`]) {
      expect(() => parsePadronLookup(wrap(body), cuit)).toThrow("ARCA query failed");
    }
  });
  it.each(["<broken>", "<!DOCTYPE x [<!ENTITY y 'SECRET'>]><x/>", "<Envelope><Body><Fault><faultstring>SECRET</faultstring></Fault></Body></Envelope>", wrap(""), wrap(general.replace(cuit, "20123456786")), wrap(general + general)])("rejects malformed/fault/wrong-identity responses without leaking body", xml => {
    expect(() => parsePadronLookup(xml, cuit)).toThrow("ARCA query failed");
  });
});
