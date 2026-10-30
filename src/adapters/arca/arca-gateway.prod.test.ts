import { ArcaQueryError } from "./query-diagnostics";
import { describe, it, expect } from "vitest";
import { ArcaGatewayProd, createArcaGatewayProd, certFingerprint } from "./arca-gateway.prod";
import { TaCache, type TaCacheStore, type WsaaProvider } from "./ta-cache";
import { WsfeClient, type WsfeTransport } from "./wsfe";
import { PadronA5Client, type PadronTransport } from "./padron";
import { signTraCms } from "./wsaa";
import { generateSelfSignedCert } from "@/test-support/pkcs7";
import type { FECAEReq } from "@/ports/arca-gateway";
import { ArcaBusinessError } from "./errors";
import { EmissionDisabledError } from "./emissions";
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
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto><EmisionTipo>CAE</EmisionTipo><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>30710145764</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
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
      return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><datosGenerales><idPersona>30710145764</idPersona></datosGenerales><datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral><impuestos><impuesto><idImpuesto>30</idImpuesto></impuesto></impuestos></personaReturn></ns2:getPersona_v2Response></soap:Body></soap:Envelope>`;
    },
  };
  return { transport, bodies };
}

const REQ: FECAEReq = {
  taxRate:21,
  cuit: "20123456786",
  ptoVta: 1,
  cbteTipo: 1,
  // Caller-pinned comprobante number (design amendment #1).
  cbteNro: 7,
  receptorDocTipo: 80,
  receptorDocNro: 30710145764,
  condicionIvaReceptorId: 6, // monotributista (RG 5616)
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
  it("does not mark issuance sent when WSAA/cache acquisition fails", async () => {
    let sends = 0; let dispatched = false;
    const gateway = new ArcaGatewayProd({
      taCache: { async get() { throw new Error("WSAA: certificado inválido"); }, async evict() { throw new Error("must not evict"); } },
      wsfe: new WsfeClient({ url: "offline", transport: { async post() { sends++; throw new Error("must not send"); } } }),
      padron: new PadronA5Client({ url: "offline", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    await expect(gateway.issueInvoice(REQ, undefined, () => { dispatched = true; })).rejects.toThrow("WSAA: certificado inválido");
    expect(dispatched).toBe(false); expect(sends).toBe(0);
  });
  it("revalidates dispatch ownership after delayed TA acquisition and sends nothing if expired", async () => {
    const events: string[] = [];
    let leaseValid = true;
    let sends = 0;
    const gateway = new ArcaGatewayProd({
      taCache: {
        async get() { events.push("ta"); leaseValid = false; return TA; },
        async evict() {},
      },
      wsfe: new WsfeClient({ url: "offline", transport: { async post() { sends++; throw Error("must not send"); } } }),
      padron: new PadronA5Client({ url: "offline", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    const beforeDispatch = async () => {
      events.push("guard");
      if (!leaseValid) throw Error("Dispatch claim expired");
    };
    await expect(gateway.issueInvoice(REQ, beforeDispatch)).rejects.toThrow("Dispatch claim expired");
    expect(events).toEqual(["ta", "guard"]);
    expect(sends).toBe(0);
  });
  it.each(["600", "10016", "10015"])("retains Errors-only %s taxonomy without inventing rejection or duplicate evidence", async code => {
    const base = wsfeTransport(); let issued = 0; let consulted = 0;
    const transport: WsfeTransport = { async post(url, body, headers) {
      if (body.includes("<ar:FECompConsultar>")) { consulted++; return base.transport.post(url,body,headers); }
      issued++;
      if (issued === 1) return `<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><Errors><Err><Code>${code}</Code><Msg>SECRET_TOKEN</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`;
      return base.transport.post(url,body,headers);
    } };
    const gateway = new ArcaGatewayProd({ taCache: new TaCache({ wsaa: fakeWsaa().wsaa, store: inMemoryStore(), clock: () => FIXED_NOW }), wsfe: new WsfeClient({ url: "offline", transport }), padron: new PadronA5Client({ url: "offline", transport: padronTransport().transport }), emissionsEnabled: true });
    if (code === "600") await expect(gateway.issueInvoice(REQ)).rejects.toMatchObject({kind:"auth",code:"600"});
    else if (code === "10015") await expect(gateway.issueInvoice(REQ)).rejects.toMatchObject({ kind:"business", code:"10015", category:"provider-errors" });
    else expect(await gateway.issueInvoice(REQ)).toMatchObject({cae:expect.stringMatching(/^\d{14}$/),cbteNro:7});
    expect(issued).toBe(1); expect(consulted).toBe(code === "10016" ? 1 : 0);
  });
  it("holds malformed consulted fiscal evidence as terminal uncertain, not a transient emission error", async () => {
    const transport: WsfeTransport = { async post(_url,body) { return body.includes("<ar:FECompConsultar>") ? "<Envelope/>" : `<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><Errors><Err><Code>10016</Code></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>`; } };
    const gateway = new ArcaGatewayProd({taCache:new TaCache({wsaa:fakeWsaa().wsaa,store:inMemoryStore(),clock:()=>FIXED_NOW}),wsfe:new WsfeClient({url:"offline",transport}),padron:new PadronA5Client({url:"offline",transport:padronTransport().transport}),emissionsEnabled:true});
    await expect(gateway.issueInvoice(REQ)).rejects.toMatchObject({kind:"business",stage:"issuance",category:"malformed-response"});
  });
  it.each(["CAEA", "wrong-number", "missing-total", "wrong-currency"])("does not recover a CAE from %s evidence", async kind => {
    const base = wsfeTransport();
    const transport: WsfeTransport = { async post(url, body, headers) {
      if (body.includes("<ar:FECAESolicitar>")) return (await base.transport.post(url, body, headers)).replaceAll("<Resultado>A</Resultado>", "<Resultado>R</Resultado>").replace(/<CAE>.*?<\/CAE>/, "").replace(/<CAEFchVto>.*?<\/CAEFchVto>/, "").replace("</FECAEDetResponse>", "<Observaciones><Obs><Code>10016</Code></Obs></Observaciones></FECAEDetResponse>");
      let response = await base.transport.post(url, body, headers);
      if (kind === "CAEA") response = response.replace("<EmisionTipo>CAE", "<EmisionTipo>CAEA");
      if (kind === "wrong-number") response = response.replaceAll(">7<", ">8<");
      if (kind === "missing-total") response = response.replace("<ImpTotal>1210.00</ImpTotal>", "");
      if (kind === "wrong-currency") response = response.replace("<MonId>PES", "<MonId>DOL");
      return response;
    } };
    const gateway = new ArcaGatewayProd({ taCache: new TaCache({ wsaa: fakeWsaa().wsaa, store: inMemoryStore(), clock: () => FIXED_NOW }), wsfe: new WsfeClient({ url: "offline", transport }), padron: new PadronA5Client({ url: "offline", transport: padronTransport().transport }), emissionsEnabled: true });
    await expect(gateway.issueInvoice(REQ)).rejects.toBeInstanceOf(ArcaBusinessError);
  });
  it("retains safe issuance rejection code without logging provider text", async () => {
    const { wsaa } = fakeWsaa();
    const logger = { error: (event: string, fields: unknown) => logs.push([event, fields]), warn: () => {}, info: () => {} };
    const logs: unknown[] = [];
    const gateway = new ArcaGatewayProd({
      taCache: new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW }),
      wsfe: new WsfeClient({ url: "https://offline.invalid", transport: { post: async () => "<Envelope><Body><FECAESolicitarResponse><FECAESolicitarResult><Errors><Err><Code>10049</Code><Msg>SECRET_TOKEN</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></Body></Envelope>" } }),
      padron: new PadronA5Client({ url: "https://offline.invalid", transport: padronTransport().transport }),
      logger, emissionsEnabled: true,
    });
    const failure = await gateway.issueInvoice(REQ).catch(e => e);
    expect(failure).toMatchObject({ code: "10049", stage: "issuance", category: "provider-errors" });
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });
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
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><errorConstancia>No existe la persona o no esta autorizado</errorConstancia></personaReturn></ns2:getPersona_v2Response></soap:Body></soap:Envelope>`;
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
    ).rejects.toBeInstanceOf(ArcaQueryError);
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

  it("re-fetches the existing CAE on duplicate (10016 in BOTH errors and observaciones)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const duplicateTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto><EmisionTipo>CAE</EmisionTipo><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>30710145764</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp><Errors><Err><Code>10016</Code><Msg>ya autorizado</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto><EmisionTipo>CAE</EmisionTipo><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>30710145764</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        // 10016 in observaciones ONLY — Errors is empty (the gap C4 closes).
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto><EmisionTipo>CAE</EmisionTipo><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>30710145764</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        // 10016 in ERRORS ONLY — no Observaciones element at all (the C4 gap).
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>10016</Code><Msg>ya autorizado</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
    // already authorized 7) answers 10016; the gateway must recover the CAE via
    // FECompConsultar WITHOUT a second FECAESolicitar for a different number.
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const ops: string[] = [];
    const retryTransport: WsfeTransport = {
      async post(_url, body) {
        if (body.includes("<ar:FECompConsultar>")) {
          ops.push("consultarComprobante");
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECompConsultarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECompConsultarResult><ResultGet><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CodAutorizacion>70212345678902</CodAutorizacion><FchVto>20261002</FchVto><EmisionTipo>CAE</EmisionTipo><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><DocTipo>80</DocTipo><DocNro>30710145764</DocNro><ImpTotal>1210.00</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.00</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz></ResultGet></FECompConsultarResult></FECompConsultarResponse></soap:Body></soap:Envelope>`;
        }
        ops.push(`solicitar`);
        // The emission was already authorized as number 7.
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado><Observaciones><Obs><Code>10016</Code><Msg>ya autorizado</Msg></Obs></Observaciones></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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

  it("never retries issuance or refreshes TA after an auth rejection", async () => {
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
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>600</Code><Msg>Token invalido</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
        }
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>A</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261002</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
    await expect(gateway.issueInvoice(REQ)).rejects.toMatchObject({kind:"auth",code:"600"});
    expect(solicitarCount).toBe(1);
    expect(loginCount).toBe(1);
    expect(metrics.snapshot().ta_evicted_auth).toBeUndefined();
  });

  it("throws on a non-duplicate ARCA rejection (no silent CAE)", async () => {
    const { wsaa } = fakeWsaa();
    const taCache = new TaCache({ wsaa, store: inMemoryStore(), clock: () => FIXED_NOW });
    const rejectingTransport: WsfeTransport = {
      async post() {
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado></FECAEDetResponse></FeDetResp><Errors><Err><Code>10049</Code><Msg>Otro error</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
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
        return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse xmlns="http://ar.gov.afip.dif.FEV1/"><FECAESolicitarResult><FeCabResp><Cuit>20123456786</Cuit><PtoVta>1</PtoVta><CbteTipo>1</CbteTipo><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>7</CbteDesde><CbteHasta>7</CbteHasta><CbteFch>20260922</CbteFch><Resultado>R</Resultado><CAE>70212345678901</CAE><CAEFchVto>20261002</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
      },
    };
    const gateway = new ArcaGatewayProd({
      taCache,
      wsfe: new WsfeClient({ url: "x", transport: rWithCaeTransport }),
      padron: new PadronA5Client({ url: "y", transport: padronTransport().transport }),
      emissionsEnabled: true,
    });
    await expect(gateway.issueInvoice(REQ)).rejects.toThrow(/malformed-response/);
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
    await expect(gateway.issueInvoice(REQ)).rejects.toBeInstanceOf(EmissionDisabledError);
    await expect(gateway.issueInvoice(REQ)).rejects.toThrow("La emisi\u00f3n est\u00e1 deshabilitada en este servidor (configuraci\u00f3n)");
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
          return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn><datosGenerales><idPersona>30710145764</idPersona></datosGenerales><datosRegimenGeneral><impuesto><idImpuesto>30</idImpuesto><estadoImpuesto>AC</estadoImpuesto></impuesto></datosRegimenGeneral></personaReturn></ns2:getPersona_v2Response></soap:Body></soap:Envelope>`;
        },
      },
      taStore: inMemoryStore(),
      emissionsEnabled: true,
      env: { EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" },
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
it("rechecks dispatch ownership after a delayed TA acquisition before any issuance POST",async()=>{
 let release!:(ta:{token:string;sign:string;expirationTime:string})=>void;
 const ticket=new Promise<{token:string;sign:string;expirationTime:string}>(resolve=>{release=resolve;});
 let expired=false,sends=0;
 const gateway=new ArcaGatewayProd({taCache:{get:async()=>ticket,evict:async()=>{}},wsfe:new WsfeClient({url:"offline",transport:{post:async()=>{sends++;throw Error("must not send");}}}),padron:new PadronA5Client({url:"offline",transport:padronTransport().transport}),emissionsEnabled:true});
 const pending=gateway.issueInvoice(REQ,async()=>{if(expired)throw Error("lease expired after TA");});
 expired=true;release({token:"fake",sign:"fake",expirationTime:"2099-01-01T00:00:00Z"});
 await expect(pending).rejects.toThrow("lease expired after TA");expect(sends).toBe(0);
});
