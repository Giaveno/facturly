import { describe, it, expect } from "vitest";
import {
  buildGetPersonaEnvelope,
  condicionIvaToReceptorId,
  padronPersonaToCondicion,
  parseGetPersonaResponse,
  PadronA5Client,
  type PadronTransport,
} from "./padron";
import { ArcaBusinessError } from "./errors";

describe("padron — padronPersonaToCondicion (design mapping table)", () => {
  it("maps impuestos id 30 (IVA regimen general) → ri", () => {
    expect(
      padronPersonaToCondicion({ impuestos: [{ idImpuesto: "30" }] }),
    ).toBe("ri");
  });

  it("uses datosRegimenGeneral as an RI signal (no impuestos needed)", () => {
    expect(
      padronPersonaToCondicion({ datosRegimenGeneral: { impuesto: 30 } }),
    ).toBe("ri");
  });

  it("maps datosMonotributo present → monotributista (even if impuestos also present)", () => {
    expect(
      padronPersonaToCondicion({
        datosMonotributo: { categoria: "B" },
        impuestos: [{ idImpuesto: "32" }],
      }),
    ).toBe("monotributista");
  });

  it("maps impuestos 32/33/34 only (no IVA) → exento", () => {
    expect(
      padronPersonaToCondicion({
        impuestos: [
          { idImpuesto: "32" },
          { idImpuesto: "33" },
          { idImpuesto: "34" },
        ],
      }),
    ).toBe("exento");
  });

  it("maps a genuinely absent person (no data, no error) → unresolved", () => {
    expect(padronPersonaToCondicion({})).toBe("unresolved");
    expect(padronPersonaToCondicion({ impuestos: [] })).toBe("unresolved");
  });

  it("THROWS on errorConstancia — a lookup error is never downgraded to CF", () => {
    expect(() =>
      padronPersonaToCondicion({ errorConstancia: "No existe la persona" }),
    ).toThrow(ArcaBusinessError);
  });

  it("THROWS on errorMonotributo — a lookup error is never downgraded to CF", () => {
    expect(() =>
      padronPersonaToCondicion({ errorMonotributo: "error" }),
    ).toThrow(ArcaBusinessError);
  });
});

describe("padron — condicionIvaToReceptorId", () => {
  it("maps the design's ReceptorId table for KNOWN conditions", () => {
    expect(condicionIvaToReceptorId("ri")).toBe(1);
    expect(condicionIvaToReceptorId("monotributista")).toBe(6);
    expect(condicionIvaToReceptorId("exento")).toBe(4);
    expect(condicionIvaToReceptorId("consumidorFinal")).toBe(5);
  });

  it("THROWS on unresolved — never silently emits Consumidor Final", () => {
    expect(() => condicionIvaToReceptorId("unresolved")).toThrow(ArcaBusinessError);
  });
});

describe("padron — SOAP envelope + parsing", () => {
  it("builds the getPersona envelope with token/sign/cuitRepresentada/idPersona", () => {
    const xml = buildGetPersonaEnvelope(
      { token: "TOKEN", sign: "SIGN", cuitRepresentada: "20123456786" },
      "30710145764",
    );
    expect(xml).toContain("<a5:getPersona>");
    expect(xml).toContain("<token>TOKEN</token>");
    expect(xml).toContain("<sign>SIGN</sign>");
    expect(xml).toContain("<cuitRepresentada>20123456786</cuitRepresentada>");
    expect(xml).toContain("<idPersona>30710145764</idPersona>");
  });

  it("escapes an idPersona with XML-special characters", () => {
    const xml = buildGetPersonaEnvelope(
      { token: "TOKEN", sign: "SIGN", cuitRepresentada: "20123456786" },
      "30&<7",
    );
    expect(xml).toContain("<idPersona>30&amp;&lt;7</idPersona>");
  });

  const MONOTRIBUTO = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <idPersona>30710145764</idPersona>
        <tipoPersona>FISICA</tipoPersona>
        <datosMonotributo>
          <categoria>B</categoria>
          <impuesto>20</impuesto>
        </datosMonotributo>
        <impuestos>
          <impuesto><idImpuesto>32</idImpuesto><descripcion>IVA Exento</descripcion></impuesto>
        </impuestos>
      </personaReturn>
    </ns2:getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  const ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <errorConstancia>No existe la persona</errorConstancia>
      </personaReturn>
    </ns2:getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  const REGIMEN_GENERAL = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <idPersona>30710145764</idPersona>
        <datosRegimenGeneral><impuesto>30</impuesto></datosRegimenGeneral>
      </personaReturn>
    </ns2:getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  it("parses a monotributista response (datosMonotributo present)", () => {
    const persona = parseGetPersonaResponse(MONOTRIBUTO);
    expect(persona.datosMonotributo).toBeDefined();
    expect(padronPersonaToCondicion(persona)).toBe("monotributista");
  });

  it("parses a datosRegimenGeneral-only response as ri (RI signal)", () => {
    const persona = parseGetPersonaResponse(REGIMEN_GENERAL);
    expect(padronPersonaToCondicion(persona)).toBe("ri");
  });

  it("throws when a lookup errors (errorConstancia) — never a silent CF", () => {
    const persona = parseGetPersonaResponse(ERROR);
    expect(() => padronPersonaToCondicion(persona)).toThrow(ArcaBusinessError);
  });
});

describe("padron — PadronA5Client.getPersona (offline)", () => {
  it("posts getPersona and returns the normalized condition with NO network", async () => {
    let posted = "";
    const transport: PadronTransport = {
      async post(_url, body) {
        posted = body;
        return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/">
      <personaReturn>
        <idPersona>30710145764</idPersona>
        <datosRegimenGeneral><impuesto>30</impuesto></datosRegimenGeneral>
        <impuestos><impuesto><idImpuesto>30</idImpuesto></impuesto></impuestos>
      </personaReturn>
    </ns2:getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
      },
    };
    const client = new PadronA5Client({
      url: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
      transport,
    });
    const result = await client.getPersona(
      "TOKEN",
      "SIGN",
      "20123456786",
      "30710145764",
    );
    expect(result).toBe("ri");
    expect(posted).toContain("<idPersona>30710145764</idPersona>");
    expect(posted).toContain("<cuitRepresentada>20123456786</cuitRepresentada>");
  });

  it("rejects a lookup error instead of returning unresolved/CF", async () => {
    const transport: PadronTransport = {
      async post() {
        return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/">
      <personaReturn><errorConstancia>No existe la persona</errorConstancia></personaReturn>
    </ns2:getPersonaResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
      },
    };
    const client = new PadronA5Client({ url: "https://x", transport });
    await expect(
      client.getPersona("TOKEN", "SIGN", "20123456786", "99999999999"),
    ).rejects.toThrow(ArcaBusinessError);
  });
});
