import { describe, it, expect } from "vitest";
import { ArcaGatewayProd, createArcaGatewayProd, certFingerprint } from "./arca-gateway.prod";
import { TaCache, type TaCacheStore, type WsaaProvider } from "./ta-cache";
import { WsfeClient, type WsfeTransport } from "./wsfe";
import { PadronA5Client, type PadronTransport } from "./padron";
import { signTraCms } from "./wsaa";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import type { FECAEReq } from "@/ports/arca-gateway";
import { ArcaBusinessError } from "./errors";
import { createInMemoryMetrics } from "./logger";

const FIXED_NOW = new Date("2026-09-22T15:00:00.000Z");
const TA = { token: "TOKEN", sign: "SIGN", expirationTime: "2026-09-23T03:00:00-03:00" };

function inMemoryStore(): TaCacheStore {
  const map = new Map();
  return {
    async get(service: string) {
      return map.get(service) ?? null;
    },
    async put(service: string, entry: unknown) {
      map.set(service, entry);
    },
    async delete(service: string) {
      map.delete(service);
    },
  };
}

function fakeWsaa(ta = TA) {
  const calls: string[] = [];
  const wsaa: WsaaProvider = {
    async loginCms(service) {
      calls.push(service);
      return ta;
    },
  };
  return { wsaa, calls };
}

// A WSFEv1 transport that routes by SOAP operation.
function wsfeTransport() {
  const ops: string[] = [];
  const transport: WsfeTransport = {
    async post(_url, body) {
      if (body.includes("<ar:FECompConsultar>")) {
        ops.push("consultarComprobante");
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
      }
      ops.push("solicitar");
      return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>A</Resultado><Reproceso>N</Reproceso></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261002</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
    },
  };
  return { transport, ops };
}

// A Padrón A5 transport returning an RI (impuestos id 30) with a captured body.
function padronTransport() {
  const bodies: string[] = [];
  const transport: PadronTransport = {
    async post(_url, body) {
      bodies.push(body);
      return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><idPersona>30710145764</idPersona><datosRegimenGeneral><impuesto>30</impuesto></datosRegimenGeneral><impuestos><impuesto><idImpuesto>30</idImpuesto></impuesto></impuestos></personaReturn></ns2:getPersonaResponse></soap:Body></soap:Envelope>`;
    },
  };
  return { transport, bodies };
}

const REQ: FECAEReq = {
  cuit: "20123456786",
  ptoVta: 1,
  cbteTipo: 1,
  // Caller-pinned comprobante number (design amendment #1).
  cbteNro: 7,
  receptorDocTipo: 80,
  receptorDocNro: 30710145764,
  receptorRazonSocial: "EMPRESA EJEMPLO S.A.",
  fechaEmision: "2026-09-22",
  fechaVto: "2026-10-22",
  moneda: "PES",
  cotizacion: 1,
  importeNeto: 100000,
  importeIva: 21000,
  importeTotal: 121000,
};

function makeGateway() {
  const { wsaa, calls } = fakeWsaa();
  const taCache = new TaCache({
    wsaa,
    store: inMemoryStore(),
    clock: () => FIXED_NOW,
  });
  const { transport: wsfeT, ops } = wsfeTransport();
  const { transport: padronT, bodies } = padronTransport();
  const gateway = new ArcaGatewayProd({
    taCache,
    wsfe: new WsfeClient({ url: "https://wsfe.example", transport: wsfeT }),
    padron: new PadronA5Client({
      url: "https://padron.example",
      transport: padronT,
    }),
    emissionsEnabled: true,
  });
  return { gateway, calls, ops, bodies };
}

describe("arca-gateway.prod — composed ARCA gateway", () => {
  it("getIvaCondition resolves via Padrón A5 with the per-call clientCuit as cuitRepresentada", async () => {
    const { gateway, calls, bodies } = makeGateway();
    const condicion = await gateway.getIvaCondition("20123456786", "30710145764");
    expect(condicion).toBe("ri");
    // The Padrón lookup must use its OWN TA (ws_sr_constancia_inscripcion).
    expect(calls).toEqual(["ws_sr_constancia_inscripcion"]);
    // cuitRepresentada = clientCuit arg, idPersona = payerCuit arg.
    expect(bodies[0]).toContain("<cuitRepresentada>20123456786</cuitRepresentada>");
    expect(bodies[0]).toContain("<idPersona>30710145764</idPersona>");
  });

  it("passes the caller's clientCuit as cuitRepresentada per call (no hardcoded construction CUIT)", async () => {
    const { gateway, bodies } = makeGateway();
    await gateway.getIvaCondition("20123456786", "30710145764");
    expect(bodies[0]).toContain("<cuitRepresentada>20123456786</cuitRepresentada>");
    expect(bodies[0]).toContain("<idPersona>30710145764</idPersona>");
  });

  it("a wrong/undelegated cuitRepresentada surfaces as a Padrón error and THROWS — never a silent CF downgrade", async () => {
    // ARCA answers a wrong (undelegated) representada with `errorConstancia`.
    // The gateway must PROPAGATE it, not map it to unresolved → Consumidor Final.
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const errTransport: PadronTransport = {
      async post() {
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><errorConstancia>No existe la persona o no esta autorizado</errorConstancia></personaReturn></ns2:getPersonaResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: wsfeTransport().transport }),
      padron: new PadronA5Client({ url: "y", transport: errTransport }),
      emissionsEnabled: true,
    });
    await expect(
      gateway.getIvaCondition("99999999999", "30710145764"),
    ).rejects.toBeInstanceOf(ArcaBusinessError);
  });

  it("issueInvoice pins the CALLER-SUPPLIED cbteNro (no ultimoAutorizado derivation)", async () => {
    const { gateway, ops } = makeGateway();
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678901");
    expect(result.cbteNro).toBe(7); // exactly the pinned number
    expect(result.caeFchVto).toBe("20261002");
    // No ultimoAutorizado call; only the emission.
    expect(ops).toEqual(["solicitar"]);
  });

  it("re-fetches the existing CAE on duplicate (10015 in BOTH errors and observaciones)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const duplicateTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp><Errors><Err><Code>10015</Code><Msg>ya autorizado</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: duplicateTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678902");
    expect(result.cbteNro).toBe(7);
  });

  it("recovers the CAE when the duplicate arrives in OBSERVACIONES ONLY (errors empty)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const obsOnlyTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        // 10016 in observaciones ONLY — Errors is empty (the gap C4 closes).
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const metrics = createInMemoryMetrics();
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: obsOnlyTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
      metrics,
    });
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678902");
    expect(result.cbteNro).toBe(7);
    expect(metrics.snapshot().arca_duplicate).toBe(1);
  });

  it("recovers the CAE when the duplicate arrives in ERRORS ONLY (observaciones empty)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const errorsOnlyTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        // 10015 in ERRORS ONLY — no Observaciones element at all (the C4 gap).
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>10015</Code><Msg>ya autorizado</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const metrics = createInMemoryMetrics();
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: errorsOnlyTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
      metrics,
    });
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678902");
    expect(result.cbteNro).toBe(7);
    expect(metrics.snapshot().arca_duplicate).toBe(1);
  });

  it("a lost-response retry replays the SAME cbteNro and NEVER solicits a second number", async () => {
    // C1: the caller retries cbteNro=7 after the response was lost. ARCA (which
    // already authorized 7) answers 10015; the gateway must recover the CAE via
    // FECompConsultar WITHOUT a second FECAESolicitar for a different number.
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const ops: string[] = [];
    const retryTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          ops.push("consultarComprobante");
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        ops.push(`solicitar`);
        // The emission was already authorized as number 7.
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado><Observaciones><Obs><Code>10015</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: retryTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678902");
    expect(result.cbteNro).toBe(7);
    // Exactly ONE solicitar (the replayed number), then the recovery call.
    // NO second FECAESolicitar for cbteNro=8.
    expect(ops).toEqual(["solicitar", "consultarComprobante"]);
  });

  it("evicts the TA and retries ONCE with a fresh TA on an auth rejection (W5)", async () => {
    // First TA is rejected with ARCA auth code 600 (invalid token); the gateway
    // must evict it, obtain a FRESH TA, and retry once.
    let loginCount = 0;
    const wsaa: WsaaProvider = {
      async loginCms() {
        loginCount++;
        return { token: `TOKEN-${loginCount}`, sign: "SIGN", expirationTime: "2026-09-23T03:00:00-03:00" };
      },
    };
    const store = inMemoryStore();
    const taCache = new TaCache({ wsaa, store, clock: () => FIXED_NOW });
    let solicitarCount = 0;
    const transport: WsfeTransport = {
      async post(_url, body) {
        if (!body.includes("<ar:FECAESolicitar>")) return "";
        solicitarCount++;
        if (solicitarCount === 1) {
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>600</Code><Msg>Token invalido</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
        }
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>A</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261002</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const metrics = createInMemoryMetrics();
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
      metrics,
    });
    const result = await gateway.issueInvoice(REQ);
    expect(result.cae).toBe("70212345678901");
    expect(result.cbteNro).toBe(7);
    expect(solicitarCount).toBe(2); // retried exactly once
    expect(loginCount).toBe(2); // a fresh TA was obtained after eviction
    expect(metrics.snapshot().ta_evicted_auth).toBe(1);
  });

  it("throws on a non-duplicate ARCA rejection (no silent CAE)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const rejectingTransport: WsfeTransport = {
      async post() {
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>10049</Code><Msg>Otro error</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: rejectingTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    await expect(gateway.issueInvoice(REQ)).rejects.toThrow(/10049/);
  });

  it("rejects a Resultado=R response that STILL carries a CAE (success gated on resultado === A)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const rWithCaeTransport: WsfeTransport = {
      async post() {
        // Resultado=R but a non-null CAE/CbteDesde — must NOT be accepted.
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><Resultado>R</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261002</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: rWithCaeTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    await expect(gateway.issueInvoice(REQ)).rejects.toThrow(/resultado=R/);
  });

  it("refuses to emit when the emissions kill switch is off", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const { transport: wsfeT } = wsfeTransport();
    const { transport: padronT } = padronTransport();
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: wsfeT }),
      padron: new PadronA5Client({ url: "y", transport: padronT }),
      emissionsEnabled: false, // default is false anyway
    });
    await expect(gateway.issueInvoice(REQ)).rejects.toBeInstanceOf(ArcaBusinessError);
    await expect(gateway.issueInvoice(REQ)).rejects.toThrow(/disabled/);
  });
});

describe("arca-gateway.prod — factory", () => {
  const FIXTURE = generateSelfSignedCert();

  function loginCmsResponse(): string {
    const inner = `<loginTicketResponse version="1.0">
  <header><uniqueId>1</uniqueId><generationTime>2026-09-22T12:30:00-03:00</generationTime><expirationTime>2026-09-23T03:00:00-03:00</expirationTime></header>
  <credentials><token>VE9LRU5fQkFTRTY0</token><sign>U0lHTl9CQVNFNjQ=</sign></credentials>
</loginTicketResponse>`;
    const cms = signTraCms(
      { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      inner,
    );
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">
      <loginCmsReturn>${cms}</loginCmsReturn>
    </loginCmsResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  it("composes WSAA + WSFEv1 + Padrón + TaCache behind the ArcaGateway port", async () => {
    const gateway = createArcaGatewayProd({
      credentials: { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      wsaaUrl: "https://wsaa.example",
      wsfeUrl: "https://wsfe.example",
      padronUrl: "https://padron.example",
      transport: {
        async post(_url, body) {
          if (body.includes("<wsaa:loginCms>")) return loginCmsResponse();
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersonaResponse xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><datosRegimenGeneral><impuesto>30</impuesto></datosRegimenGeneral></personaReturn></ns2:getPersonaResponse></soap:Body></soap:Envelope>`;
        },
      },
      taStore: inMemoryStore(),
      emissionsEnabled: true,
    });
    const condicion = await gateway.getIvaCondition("20123456786", "30710145764");
    expect(condicion).toBe("ri");
  });

  it("computes a stable cert fingerprint for cache scoping", () => {
    const fp = certFingerprint("cert-a");
    expect(fp).toBe(certFingerprint("cert-a"));
    expect(fp).not.toBe(certFingerprint("cert-b"));
    expect(fp).toHaveLength(16);
  });
});
