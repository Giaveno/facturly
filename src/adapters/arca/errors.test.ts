import { describe, it, expect } from "vitest";
import {
  ArcaAuthError,
  ArcaBusinessError,
  ArcaError,
  ArcaTransientError,
  arcaErrorForCode,
  classifyArcaErrorCode,
  classifyFaultCode,
  hasSoapFault,
  normalizeFaultCode,
  parseSoapFault,
} from "./errors";

describe("errors — taxonomy", () => {
  it("tags each error class with the right kind and name", () => {
    expect(new ArcaTransientError("x").kind).toBe("transient");
    expect(new ArcaBusinessError("x").kind).toBe("business");
    expect(new ArcaAuthError("x").kind).toBe("auth");
    expect(new ArcaTransientError("x")).toBeInstanceOf(ArcaError);
    expect(new ArcaTransientError("x")).toBeInstanceOf(Error);
  });

  it("stores only normalized allowlisted faultcodes and never faultstring text", () => {
    const allowed = new ArcaBusinessError("rejected", {
      code: "10049",
      faultcode: "soapenv:coe.alreadyAuthenticated",
      faultstring: "SECRET provider text",
      retryAfterMs: 5000,
    });
    const unknown = new ArcaBusinessError("rejected", {
      faultcode: "soapenv:Client",
      faultstring: "OTHER SECRET",
    });
    expect(allowed.code).toBe("10049");
    expect(allowed.faultcode).toBe("coe.alreadyAuthenticated");
    expect(allowed.faultstring).toBeUndefined();
    expect(allowed.retryAfterMs).toBe(5000);
    expect(unknown.faultcode).toBe("unknown");
    expect(unknown.faultstring).toBeUndefined();
  });
});

describe("errors — SOAP Fault parsing", () => {
  const FAULT = `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultcode>soapenv:Server</faultcode>
      <faultstring>Internal error</faultstring>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;

  it("extracts faultcode/faultstring from a Fault envelope", () => {
    expect(parseSoapFault(FAULT)).toEqual({
      faultcode: "soapenv:Server",
      faultstring: "Internal error",
    });
  });

  it("returns null for a non-Fault body", () => {
    expect(parseSoapFault("<Envelope><Body><Ok/></Body></Envelope>")).toBeNull();
    expect(hasSoapFault(FAULT)).toBe(true);
    expect(hasSoapFault("<Envelope/>")).toBe(false);
  });

  it("returns null for malformed XML instead of throwing", () => {
    expect(parseSoapFault("not xml at all")).toBeNull();
  });
});

describe("errors — classification", () => {
  it.each([
    ["coe.alreadyAuthenticated", "coe.alreadyAuthenticated"],
    ["ns1:coe.notAuthorized", "coe.notAuthorized"],
    ["cms.cert.untrusted", "cms.cert.untrusted"],
    ["cms.cert.expired", "cms.cert.expired"],
    ["cms.sign.invalid", "cms.sign.invalid"],
    ["xml.generationTime.invalid", "xml.generationTime.invalid"],
    ["xml.expirationTime.expired", "xml.expirationTime.expired"],
    ["soapenv:Client", "unknown"],
    [undefined, "unknown"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeFaultCode(input)).toBe(expected);
  });

  it.each([
    ["coe.alreadyAuthenticated", "business"],
    ["coe.notAuthorized", "auth"],
    ["cms.cert.untrusted", "auth"],
    ["cms.cert.expired", "auth"],
    ["cms.sign.invalid", "auth"],
    ["xml.generationTime.invalid", "business"],
    ["xml.expirationTime.expired", "business"],
    ["Server", "transient"],
    ["soapenv:Server", "transient"],
    ["ns2:failedAuthentication", "business"],
    [undefined, "business"],
  ])("classifies explicit fault code %s as %s", (faultcode, expected) => {
    expect(classifyFaultCode(faultcode)).toBe(expected);
  });

  it("classifies ARCA codes without misclassifying no-data 602 as auth", () => {
    expect(classifyArcaErrorCode("10015")).toBe("business");
    expect(classifyArcaErrorCode("10016")).toBe("duplicate");
    expect(classifyArcaErrorCode("600")).toBe("auth");
    expect(classifyArcaErrorCode("601")).toBe("auth");
    expect(classifyArcaErrorCode("602")).toBe("business");
    expect(classifyArcaErrorCode("10049")).toBe("business");
  });

  it("builds the right error class for a classified code", () => {
    expect(arcaErrorForCode("600", "token expirado")).toBeInstanceOf(ArcaAuthError);
    expect(arcaErrorForCode("10049", "otro")).toBeInstanceOf(ArcaBusinessError);
    expect(arcaErrorForCode("10015", "ya autorizado")).toBeInstanceOf(
      ArcaBusinessError,
    );
  });
});
