import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import {
  buildFecaesolicitarEnvelope,
  buildFecompConsultarEnvelope,
  buildFecompUltimoAutorizadoEnvelope,
  fecaReqToSolicitar,
  parseFecaesolicitarResponse,
  parseFecompConsultarResponse,
  parseFecompUltimoAutorizadoResponse,
  WsfeClient,
  type FecaesolicitarRequest,
  type WsfeTransport,
} from "./wsfe";
import type { FECAEReq } from "@/ports/arca-gateway";

const AUTH = {
  token: "VE9LRU5fQkFTRTY0",
  sign: "U0lHTl9CQVNFNjQ=",
  cuit: "20123456786",
};

const REQ: FecaesolicitarRequest = {
  ptoVta: 1,
  cbteTipo: 1,
  cbteNro: 7,
  concepto: 1,
  docTipo: 80,
  docNro: 30710145764,
  condicionIvaReceptorId: 6, // monotributista (RG 5616)
  cbteFch: "2026-09-22",
  impNetoCentavos: 100000,
  impIvaCentavos: 21000,
  impTotalCentavos: 121000,
  fchVtoPago: "2026-10-22",
  monId: "PES",
  monCotiz: 1,
  iva: [{ id: 5, baseImpCentavos: 100000, importeCentavos: 21000 }],
};

describe("wsfe — buildFecaesolicitarEnvelope", () => {
  it("builds the exact FECAESolicitar SOAP envelope with the Auth block", () => {
    const xml = buildFecaesolicitarEnvelope(AUTH, REQ);
    // Auth carries Token/Sign/Cuit — Cuit is the CLIENT CUIT (delegation model).
    expect(xml).toContain("<ar:Token>VE9LRU5fQkFTRTY0</ar:Token>");
    expect(xml).toContain("<ar:Sign>U0lHTl9CQVNFNjQ=</ar:Sign>");
    expect(xml).toContain("<ar:Cuit>20123456786</ar:Cuit>");
    // Cabecera.
    expect(xml).toContain("<ar:CantReg>1</ar:CantReg>");
    expect(xml).toContain("<ar:PtoVta>1</ar:PtoVta>");
    expect(xml).toContain("<ar:CbteTipo>1</ar:CbteTipo>");
    // Detalle: dates in yyyyMMdd, amounts in 2-decimals from centavos.
    expect(xml).toContain("<ar:CbteDesde>7</ar:CbteDesde>");
    expect(xml).toContain("<ar:CbteHasta>7</ar:CbteHasta>");
    expect(xml).toContain("<ar:CbteFch>20260922</ar:CbteFch>");
    expect(xml).toContain("<ar:ImpTotal>1210.00</ar:ImpTotal>");
    expect(xml).toContain("<ar:ImpNeto>1000.00</ar:ImpNeto>");
    expect(xml).toContain("<ar:ImpIVA>210.00</ar:ImpIVA>");
    expect(xml).not.toContain("<ar:FchVtoPago>");
    expect(xml).toContain("<ar:MonId>PES</ar:MonId>");
    expect(xml).toContain("<ar:MonCotiz>1</ar:MonCotiz>");
    // IVA breakdown.
    expect(xml).toContain("<ar:Id>5</ar:Id>");
    expect(xml).toContain("<ar:BaseImp>1000.00</ar:BaseImp>");
    expect(xml).toContain("<ar:Importe>210.00</ar:Importe>");
  });

  it("formats an 11-digit receptor doc number (CUIT) without coercion", () => {
    const xml = buildFecaesolicitarEnvelope(AUTH, {
      ...REQ,
      docNro: 30710145764,
    });
    expect(xml).toContain("<ar:DocNro>30710145764</ar:DocNro>");
  });

  it("escapes a MonId with XML-special characters and rejects a non-currency code", () => {
    // A currency code with special chars must be escaped, not injected.
    expect(() =>
      buildFecaesolicitarEnvelope(AUTH, { ...REQ, monId: "PE&S" }),
    ).toThrow(/MonId/);
    // A valid code passes through unmodified.
    const ok = buildFecaesolicitarEnvelope(AUTH, { ...REQ, monId: "USD" });
    expect(ok).toContain("<ar:MonId>USD</ar:MonId>");
  });
});

describe("wsfe — fecaReqToSolicitar → buildFecaesolicitarEnvelope (cross-boundary, C1)", () => {
  // The port `FECAEReq` (emission service) is the single source of truth for
  // the field mapping. This drives the REAL pipeline into the SOAP bytes and
  // asserts DocTipo (80/99) and CondicionIVAReceptorId (RG 5616) land in the
  // serialized envelope — the exact fields that were once swapped. If a future
  // refactor re-swaps them, THESE tests fail.
  const base: FECAEReq = {
  taxRate:21,
    cuit: "20123456789",
    ptoVta: 1,
    cbteTipo: 1,
    cbteNro: 7,
    receptorDocTipo: 80,
    receptorDocNro: 30710145764,
    condicionIvaReceptorId: 6,
    receptorRazonSocial: "MONOTRIBUTISTA S.A.",
    fechaEmision: "2026-09-22",
    fechaVto: "2026-10-22",
    moneda: "PES",
    cotizacion: 1,
    importeNeto: 100000,
    importeIva: 21000,
    importeTotal: 121000,
  };

  it("Monotributista receptor → DocTipo 80 + CondicionIVAReceptorId 6 in the envelope bytes", () => {
    const xml = buildFecaesolicitarEnvelope(AUTH, fecaReqToSolicitar(base));
    expect(xml).toContain("<ar:DocTipo>80</ar:DocTipo>");
    expect(xml).toContain("<ar:CondicionIVAReceptorId>6</ar:CondicionIVAReceptorId>");
    // The document NUMBER is the 11-digit CUIT (never the IVA condition id).
    expect(xml).toContain("<ar:DocNro>30710145764</ar:DocNro>");
  });

  it("Consumidor Final receptor → DocTipo 99 + CondicionIVAReceptorId 5 + DocNro 0", () => {
    const cf: FECAEReq = {
      ...base,
      taxRate:21,
      cbteTipo: 6, // Factura B — no IVA breakdown for a final consumer
      receptorDocTipo: 99,
      receptorDocNro: 0,
      condicionIvaReceptorId: 5,
      importeNeto: 100000,
      importeIva: 21000,
      importeTotal: 121000,
    };
    const xml = buildFecaesolicitarEnvelope(AUTH, fecaReqToSolicitar(cf));
    expect(xml).toContain("<ar:DocTipo>99</ar:DocTipo>");
    expect(xml).toContain("<ar:CondicionIVAReceptorId>5</ar:CondicionIVAReceptorId>");
    expect(xml).toContain("<ar:DocNro>0</ar:DocNro>");
  });
});

describe("wsfe — parseFecaesolicitarResponse", () => {
  const SUCCESS = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECAESolicitarResult>
        <FeCabResp>
          <Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo>
          <FchProceso>20260922170000</FchProceso><CantReg>1</CantReg>
          <Resultado>A</Resultado><Reproceso>N</Reproceso>
        </FeCabResp>
        <FeDetResp>
          <FECAEDetResponse>
            <Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>30710145764</DocNro>
            <CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch>
            <Resultado>A</Resultado>
            <Observaciones>
              <Obs><Code>10002</Code><Msg>Sin errores</Msg></Obs>
            </Observaciones>
            <CAE>70212345678901</CAE>
            <CAEFchVto>20261002</CAEFchVto>
          </FECAEDetResponse>
        </FeDetResp>
        <Events/>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  </soap:Body>
</soap:Envelope>`;

  const DUPLICATE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECAESolicitarResult>
        <FeCabResp>
          <Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo>
          <FchProceso>20260922170000</FchProceso><CantReg>1</CantReg>
          <Resultado>R</Resultado><Reproceso>N</Reproceso>
        </FeCabResp>
        <FeDetResp>
          <FECAEDetResponse>
            <Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>30710145764</DocNro>
            <CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch>
            <Resultado>R</Resultado>
            <Observaciones>
              <Obs><Code>10015</Code><Msg>El comprobante ya fue autorizado</Msg></Obs>
            </Observaciones>
          </FECAEDetResponse>
        </FeDetResp>
        <Errors>
          <Err><Code>10015</Code><Msg>El comprobante ya fue autorizado</Msg></Err>
        </Errors>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  </soap:Body>
</soap:Envelope>`;

  it("parses CAE (14 digits), CAEFchVto, CbteNro, Resultado from a success envelope", () => {
    const r = parseFecaesolicitarResponse(SUCCESS);
    expect(r.resultado).toBe("A");
    expect(r.cae).toBe("70212345678901");
    expect(r.cae).toHaveLength(14);
    expect(r.caeFchVto).toBe("20261002");
    expect(r.cbteNro).toBe(7);
    expect(r.errors).toEqual([]);
    expect(r.observaciones).toEqual([
      { code: "10002", msg: "ARCA provider observation" },
    ]);
  });

  it("maps the duplicate error (10015) into the errors array with Resultado R", () => {
    const r = parseFecaesolicitarResponse(DUPLICATE);
    expect(r.resultado).toBe("R");
    expect(r.cae).toBeNull();
    expect(r.errors).toEqual([
      { code: "10015", msg: "ARCA provider observation" },
    ]);
  });

  it("maps multiple observation/error entries (array normalization)", () => {
    const multi = SUCCESS.replace(
      "<Observaciones>\n              <Obs><Code>10002</Code><Msg>Sin errores</Msg></Obs>\n            </Observaciones>",
      "<Observaciones>\n<Obs><Code>10002</Code><Msg>uno</Msg></Obs>\n<Obs><Code>10003</Code><Msg>dos</Msg></Obs>\n</Observaciones>",
    );
    const r = parseFecaesolicitarResponse(multi);
    expect(r.observaciones).toHaveLength(2);
    expect(r.observaciones.map((o) => o.code)).toEqual(["10002", "10003"]);
  });

  it("preserves a full 14-digit CAE as a string (no numeric coercion)", () => {
    const bigCae = SUCCESS.replace("70212345678901", "79999999999999");
    const r = parseFecaesolicitarResponse(bigCae);
    expect(r.cae).toBe("79999999999999");
    expect(r.cae).toHaveLength(14);
  });
});

describe("wsfe — envelope well-formedness (round-trip through an XML parser)", () => {
  it("produces well-formed XML for every envelope builder", () => {
    const envelopes = [
      buildFecaesolicitarEnvelope(AUTH, REQ),
      buildFecompConsultarEnvelope(AUTH, {
        ptoVta: 1,
        cbteTipo: 1,
        cbteNro: 7,
      }),
      buildFecompUltimoAutorizadoEnvelope(AUTH, { ptoVta: 1, cbteTipo: 1 }),
    ];
    for (const xml of envelopes) {
      const result = XMLValidator.validate(xml);
      expect(result, `envelope is not well-formed:\n${xml}`).toBe(true);
    }
  });
});

describe("wsfe — FECompConsultar + FECompUltimoAutorizado", () => {
  it("builds the FECompConsultar envelope with ptoVta/cbteTipo/cbteNro", () => {
    const xml = buildFecompConsultarEnvelope(AUTH, {
      ptoVta: 1,
      cbteTipo: 1,
      cbteNro: 7,
    });
    expect(xml).toContain("<ar:FECompConsultar>");
    expect(xml).toContain("<ar:PtoVta>1</ar:PtoVta>");
    expect(xml).toContain("<ar:CbteTipo>1</ar:CbteTipo>");
    expect(xml).toContain("<ar:CbteNro>7</ar:CbteNro>");
  });

  it("parses the FECompConsultar response (CodAutorizacion + FchVto)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECompConsultarResult>
        <ResultGet>
          <CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch>
          <Resultado>A</Resultado>
          <CodAutorizacion>70212345678901</CodAutorizacion>
          <EmisionTipo>CAE</EmisionTipo>
          <FchVto>20261002</FchVto>
          <PtoVta>1</PtoVta><CbteTipo>1</CbteTipo>
        </ResultGet>
      </FECompConsultarResult>
    </FECompConsultarResponse>
  </soap:Body>
</soap:Envelope>`;
    const r = parseFecompConsultarResponse(xml);
    expect(r.cae).toBe("70212345678901");
    expect(r.caeFchVto).toBe("20261002");
    expect(r.cbteNro).toBe(7);
    expect(r.resultado).toBe("A");
  });

  it("builds and parses FECompUltimoAutorizado (next number)", () => {
    const reqXml = buildFecompUltimoAutorizadoEnvelope(AUTH, {
      ptoVta: 1,
      cbteTipo: 1,
    });
    expect(reqXml).toContain("<ar:FECompUltimoAutorizado>");
    expect(reqXml).toContain("<ar:PtoVta>1</ar:PtoVta>");
    expect(reqXml).toContain("<ar:CbteTipo>1</ar:CbteTipo>");

    const resp = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECompUltimoAutorizadoResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECompUltimoAutorizadoResult>
        <PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><CbteNro>6</CbteNro>
      </FECompUltimoAutorizadoResult>
    </FECompUltimoAutorizadoResponse>
  </soap:Body>
</soap:Envelope>`;
    expect(parseFecompUltimoAutorizadoResponse(resp)).toBe(6);
  });
});

describe("wsfe — WsfeClient (injectable transport, offline)", () => {
  it("posts the envelope and parses the response with NO network", async () => {
    let posted = "";
    const transport: WsfeTransport = {
      async post(_url, body) {
        posted = body;
        return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/">
      <FECAESolicitarResult>
        <FeCabResp>
          <Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo>
          <FchProceso>20260922170000</FchProceso><CantReg>1</CantReg>
          <Resultado>A</Resultado><Reproceso>N</Reproceso>
        </FeCabResp>
        <FeDetResp>
          <FECAEDetResponse>
            <Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>30710145764</DocNro>
            <CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch>
            <Resultado>A</Resultado>
            <CAE>70212345678901</CAE>
            <CAEFchVto>20261002</CAEFchVto>
          </FECAEDetResponse>
        </FeDetResp>
      </FECAESolicitarResult>
    </FECAESolicitarResponse>
  </soap:Body>
</soap:Envelope>`;
      },
    };
    const client = new WsfeClient({
      url: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
      transport,
    });
    const result = await client.solicitar(AUTH, REQ);
    expect(result.cae).toBe("70212345678901");
    expect(result.cbteNro).toBe(7);
    expect(posted).toContain("<ar:FECAESolicitar>");
    expect(posted).toContain("<ar:Cuit>20123456786</ar:Cuit>");
  });
});

it("matches the official homologacion WSDL FEDetRequest sequence and goods date omission", () => {
  const wsdl = readFileSync(new URL("./fixtures/wsfe-homologacion.wsdl", import.meta.url), "utf8");
  const base = /<s:complexType name="FEDetRequest">([\s\S]*?)<\/s:complexType>/.exec(wsdl)![1]!;
  const names = [...base.matchAll(/<s:element[^>]* name="([^"]+)"/g)].map(m => m[1]!);
  const xml = buildFecaesolicitarEnvelope(AUTH, REQ);
  const detail = /<ar:FECAEDetRequest>(.*?)<\/ar:FECAEDetRequest>/.exec(xml)![1]!;
  const emitted = [...detail.matchAll(/<ar:(\w+)>/g)].map(m => m[1]!).filter(n => names.includes(n));
  expect(emitted).toEqual(names.filter(n => emitted.includes(n)));
  expect(xml).not.toContain("FchVtoPago");
  const service = buildFecaesolicitarEnvelope(AUTH, { ...REQ, concepto: 2 });
  expect(service).toContain("<ar:FchVtoPago>20261022</ar:FchVtoPago>");
});
