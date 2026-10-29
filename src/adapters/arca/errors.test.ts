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

  it("carries code/faultcode/faultstring/retryAfterMs through", () => {
    const e = new ArcaBusinessError("rejected", {
      code: "10049",
      faultcode: "soapenv:Client",
      faultstring: "bad request",
      retryAfterMs: 5000,
    });
    expect(e.code).toBe("10049");
    expect(e.faultcode).toBe("soapenv:Client");
    expect(e.faultstring).toBe("bad request");
    expect(e.retryAfterMs).toBe(5000);
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
  it("classifies fault codes: Server→transient, Client→business, auth-ish→auth", () => {
    expect(classifyFaultCode("soapenv:Server")).toBe("transient");
    expect(classifyFaultCode("soapenv:Client")).toBe("business");
    expect(classifyFaultCode("ns2:failedAuthentication")).toBe("auth");
    expect(classifyFaultCode("ns2:InvalidExpiredToken")).toBe("auth");
    expect(classifyFaultCode(undefined)).toBe("business");
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
