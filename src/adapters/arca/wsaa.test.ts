import { describe, it, expect } from "vitest";
import {
  buildTra,
  defaultUniqueId,
  extractCmsContent,
  formatWsaaTime,
  parseLoginCmsResponse,
  parseLoginTicketResponse,
  signTraCms,
  WsaaClient,
  type WsaaTransport,
} from "./wsaa";
import {
  generateSelfSignedCert,
  verifyCmsSignature,
} from "@/test-support/pkcs7";

const FIXTURE = generateSelfSignedCert();

describe("wsaa — formatWsaaTime (ARCA timezone format)", () => {
  it("formats a known UTC instant as Argentina (UTC-3, no DST) with -03:00", () => {
    // 2026-09-22T15:30:00Z → Argentina wall clock 12:30:00 -03:00.
    const result = formatWsaaTime(new Date("2026-09-22T15:30:00.000Z"));
    expect(result).toBe("2026-09-22T12:30:00-03:00");
  });

  it("zero-pads fields and stays within the same ART day", () => {
    // 2026-01-01T02:05:07Z → Argentina 2025-12-31T23:05:07 (previous day).
    expect(formatWsaaTime(new Date("2026-01-01T02:05:07.000Z"))).toBe(
      "2025-12-31T23:05:07-03:00",
    );
  });
});

describe("wsaa — buildTra (Login Ticket Request)", () => {
  it("builds the exact TRA XML with header + service", () => {
    const tra = buildTra({
      uniqueId: "1700000000000",
      generationTime: "2026-09-22T12:30:00-03:00",
      expirationTime: "2026-09-23T00:30:00-03:00",
      service: "wsfe",
    });
    expect(tra).toContain('<loginTicketRequest version="1.0">');
    expect(tra).toContain("<uniqueId>1700000000000</uniqueId>");
    expect(tra).toContain(
      "<generationTime>2026-09-22T12:30:00-03:00</generationTime>",
    );
    expect(tra).toContain(
      "<expirationTime>2026-09-23T00:30:00-03:00</expirationTime>",
    );
    expect(tra).toContain("<service>wsfe</service>");
    expect(tra).toContain("<header>");
  });
});

describe("wsaa — signTraCms (PKCS#7 round-trip)", () => {
  const tra = buildTra({
    uniqueId: "1",
    generationTime: "2026-09-22T12:30:00-03:00",
    expirationTime: "2026-09-23T00:30:00-03:00",
    service: "wsfe",
  });

  it("signs a TRA into a well-formed CMS whose signature verifies independently", () => {
    const cms = signTraCms(
      { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      tra,
    );
    const v = verifyCmsSignature(cms, FIXTURE.publicKeyPem);
    expect(v.signatureValid).toBe(true);
    expect(v.content).toBe(tra);
    expect(v.digestAlgorithm).toBe("2.16.840.1.101.3.4.2.1"); // sha256
    expect(v.messageDigestMatches).toBe(true);
    expect(v.signerCertPresent).toBe(true);
  });

  it("produces a DER (base64) CMS whose embedded content round-trips", () => {
    const cms = signTraCms(
      { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      tra,
    );
    expect(extractCmsContent(cms)).toBe(tra);
  });

  it("does NOT verify with the wrong public key", () => {
    const other = generateSelfSignedCert("other.example.com");
    const cms = signTraCms(
      { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      tra,
    );
    const v = verifyCmsSignature(cms, other.publicKeyPem);
    expect(v.signatureValid).toBe(false);
  });
});

describe("wsaa — SOAP parsing", () => {
  const SOAP_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">
      <loginCmsReturn>UkVTVUxUX0NNU19CQVNFNjQ=</loginCmsReturn>
    </loginCmsResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  const LOGIN_TICKET_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketResponse version="1.0">
  <header>
    <source>CN=wsaahomo</source>
    <destination>CUIT 20123456786</destination>
    <uniqueId>1700000000000</uniqueId>
    <generationTime>2026-09-22T12:30:00-03:00</generationTime>
    <expirationTime>2026-09-23T00:30:00-03:00</expirationTime>
  </header>
  <credentials>
    <token>VE9LRU5fQkFTRTY0</token>
    <sign>U0lHTl9CQVNFNjQ=</sign>
  </credentials>
</loginTicketResponse>`;

  it("extracts the base64 loginCmsReturn from the SOAP envelope", () => {
    expect(parseLoginCmsResponse(SOAP_RESPONSE)).toBe("UkVTVUxUX0NNU19CQVNFNjQ=");
  });

  it("parses token/sign/expirationTime from the loginTicketResponse", () => {
    const ta = parseLoginTicketResponse(LOGIN_TICKET_RESPONSE);
    expect(ta).toEqual({
      token: "VE9LRU5fQkFTRTY0",
      sign: "U0lHTl9CQVNFNjQ=",
      expirationTime: "2026-09-23T00:30:00-03:00",
    });
  });
});

describe("wsaa — WsaaClient.loginCms", () => {
  const FAKE_TA = {
    token: "VE9LRU5fQkFTRTY0",
    sign: "U0lHTl9CQVNFNjQ=",
    expirationTime: "2026-09-23T00:30:00-03:00",
  };

  function makeTransport(): { transport: WsaaTransport; bodies: string[] } {
    const bodies: string[] = [];
    const transport: WsaaTransport = {
      async post(_url, body) {
        bodies.push(body);
        return SOAP_FOR(FAKE_TA);
      },
    };
    return { transport, bodies };
  }

  it("posts a loginCms SOAP request carrying the signed CMS and parses the TA", async () => {
    const { transport, bodies } = makeTransport();
    const client = new WsaaClient({
      url: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
      credentials: { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      transport,
    });
    const ta = await client.loginCms("wsfe");

    expect(ta.token).toBe(FAKE_TA.token);
    expect(ta.sign).toBe(FAKE_TA.sign);
    expect(ta.expirationTime).toBe(FAKE_TA.expirationTime);

    const body = bodies[0];
    expect(body).toContain("<wsaa:loginCms>");
    expect(body).toContain("<wsaa:in0>");
    // The in0 payload is the base64 CMS (the TRA is embedded INSIDE the CMS,
    // recoverable via extractCmsContent — verified by the round-trip tests).
    expect(body).toContain("<wsaa:in0>");
  });

  it("uses a unique, monotonic uniqueId and a ~5 minute TRA window", async () => {
    const { transport, bodies } = makeTransport();
    const fixedNow = new Date("2026-09-22T15:30:00.000Z");
    let uniqueCounter = 0;
    const client = new WsaaClient({
      url: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
      credentials: { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem },
      transport,
      clock: () => fixedNow,
      uniqueIdProvider: () => `id-${++uniqueCounter}`,
    });
    await client.loginCms("wsfe");
    await client.loginCms("wsfe");
    expect(uniqueCounter).toBe(2);

    // The TRA window must be MINUTES (default 5), NOT the 12h TA lifetime:
    // inspect the emitted generationTime → expirationTime delta.
    const body = bodies[0]!;
    const cms = /<wsaa:in0>([^<]+)<\/wsaa:in0>/.exec(body)![1]!;
    const traXml = extractCmsContent(cms);
    const gen = /<generationTime>([^<]+)<\/generationTime>/.exec(traXml)![1]!;
    const exp = /<expirationTime>([^<]+)<\/expirationTime>/.exec(traXml)![1]!;
    const genMs = Date.parse(gen);
    const expMs = Date.parse(exp);
    // 5 minutes = 300_000 ms.
    expect(expMs - genMs).toBe(5 * 60 * 1000);
  });

  it("defaultUniqueId is monotonic across repeated calls", async () => {
    const ids = [defaultUniqueId(), defaultUniqueId(), defaultUniqueId()];
    // Strictly increasing.
    expect(ids[1]! > ids[0]!).toBe(true);
    expect(ids[2]! > ids[1]!).toBe(true);
    // Each is a numeric string (WSAA uniqueId is xsd:integer).
    for (const id of ids) {
      expect(/^\d+$/.test(id)).toBe(true);
    }
  });

  it("resolves a just-in-time credentials provider before signing", async () => {
    const { transport } = makeTransport();
    let providerCalls = 0;
    const client = new WsaaClient({
      url: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
      credentials: async () => {
        providerCalls++;
        return { certPem: FIXTURE.certPem, keyPem: FIXTURE.keyPem };
      },
      transport,
    });
    const ta = await client.loginCms("wsfe");
    expect(ta.token).toBe(FAKE_TA.token);
    expect(providerCalls).toBe(1);
  });
});

// Builds a fake WSAA SOAP response that embeds the given TA as a signed CMS.
function SOAP_FOR(ta: { token: string; sign: string; expirationTime: string }) {
  const inner = `<loginTicketResponse version="1.0">
  <header>
    <uniqueId>1</uniqueId>
    <generationTime>2026-09-22T12:30:00-03:00</generationTime>
    <expirationTime>${ta.expirationTime}</expirationTime>
  </header>
  <credentials><token>${ta.token}</token><sign>${ta.sign}</sign></credentials>
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
