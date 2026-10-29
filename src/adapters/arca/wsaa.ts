/**
 * WSAA (`LoginCms`) adapter — obtains a Token+Sign (the "TA") from ARCA by
 * signing a TRA (Login Ticket Request) with CMS/PKCS#7 and posting it to the
 * `LoginCms` SOAP operation.
 *
 * Signing library decision: **node-forge** (pure JS, `forge.pkcs7`). Chosen
 * over the `openssl` CLI `smime -sign` because node-forge has NO external binary
 * dependency and works in serverless runtimes where the `openssl` binary does
 * not exist. Tradeoff: node-forge's PKCS#7 `sign()` is unproven against ARCA's
 * validator (ARCA publishes no test vectors), and its `verify()` is unimplemented
 * — so the offline test verifies the signature with an INDEPENDENT implementation
 * (Node `crypto`). The ARCA-specific correctness of the signature is only
 * provable in homologación (see `scripts/homologacion-spike.ts`).
 *
 * Security: tokens, signs, private keys, and cert contents are NEVER logged.
 */

import forge from "node-forge";
import { XMLParser } from "fast-xml-parser";
import { noopLogger, noopMetrics, type ArcaLogger, type ArcaMetrics } from "./logger";
import { ArcaQueryError } from "./query-diagnostics";

// node-forge's `pki.oids` is typed as an index signature (`string | undefined`
// under noUncheckedIndexedAccess), but these OID constants always exist.
const OID = {
  sha256: forge.pki.oids.sha256 as string,
  contentType: forge.pki.oids.contentType as string,
  messageDigest: forge.pki.oids.messageDigest as string,
  signingTime: forge.pki.oids.signingTime as string,
  data: forge.pki.oids.data as string,
};

/** The accountant's X.509 certificate + private key (PEM). */
export interface WsaaCredentials {
  certPem: string;
  keyPem: string;
}

/** A WSAA ticket — `token`/`sign` are base64, `expirationTime` is ARCA-formatted. */
export interface WsaaTa {
  token: string;
  sign: string;
  expirationTime: string;
}

/** Injectable HTTP transport (offline tests substitute a fake). */
export interface WsaaTransport {
  post(url: string, body: string, headers: Record<string, string>): Promise<string>;
}

/** Inputs to a TRA (Login Ticket Request). */
export interface TraInput {
  uniqueId: string;
  generationTime: string;
  expirationTime: string;
  service: string;
}

const XML_PARSER = () =>
  new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    // Values stay strings — tokens/signs are base64, times are ISO strings.
    parseTagValue: false,
    parseAttributeValue: false,
  });

const SOAP_HEADERS: Record<string, string> = {
  "Content-Type": "text/xml; charset=utf-8",
  SOAPAction: "",
};

const WSAA_NAMESPACE = "http://wsaa.view.sua.dvadac.desein.afip.gov";

/** Argentina is UTC-3 (ART) year-round — no DST since 2009. */
const ARGENTINA_OFFSET_MS = -3 * 3600 * 1000;

/**
 * Formats a Date in the exact format ARCA's WSAA expects for
 * `generationTime`/`expirationTime`: `YYYY-MM-DDTHH:MM:SS-03:00`.
 *
 * ARCA requires the Argentina timezone offset (fixed `-03:00`, no DST). The
 * wall-clock time is derived from UTC minus 3 hours; milliseconds are omitted
 * (ARCA accepts the second-precision form).
 */
export function formatWsaaTime(date: Date): string {
  const art = new Date(date.getTime() + ARGENTINA_OFFSET_MS);
  const y = art.getUTCFullYear();
  const m = String(art.getUTCMonth() + 1).padStart(2, "0");
  const d = String(art.getUTCDate()).padStart(2, "0");
  const hh = String(art.getUTCHours()).padStart(2, "0");
  const mm = String(art.getUTCMinutes()).padStart(2, "0");
  const ss = String(art.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}-03:00`;
}

/**
 * Builds the TRA XML per the WSAA WSDL: a `loginTicketRequest` with a `header`
 * (`uniqueId`, `generationTime`, `expirationTime`) and the requested `service`.
 * `source`/`destination` are optional (minOccurs=0) and omitted.
 */
export function buildTra(input: TraInput): string {
  return (
    '<loginTicketRequest version="1.0">' +
    "<header>" +
    `<uniqueId>${input.uniqueId}</uniqueId>` +
    `<generationTime>${input.generationTime}</generationTime>` +
    `<expirationTime>${input.expirationTime}</expirationTime>` +
    "</header>" +
    `<service>${input.service}</service>` +
    "</loginTicketRequest>"
  );
}

/**
 * Signs a TRA with CMS/PKCS#7 (SignedData, detached=false) using node-forge and
 * returns the DER structure base64-encoded — the value passed to `loginCms`'s
 * `in0`. Signature is RSA-SHA256 with signed attributes contentType +
 * messageDigest + signingTime (mirrors `openssl smime -sign`).
 */
export function signTraCms(
  credentials: WsaaCredentials,
  traXml: string,
): string {
  const cert = forge.pki.certificateFromPem(credentials.certPem);
  const key = forge.pki.privateKeyFromPem(credentials.keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: OID.sha256,
    authenticatedAttributes: [
      { type: OID.contentType, value: OID.data },
      { type: OID.messageDigest },
      { type: OID.signingTime },
    ],
  });
  p7.sign({ detached: false });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, "binary").toString("base64");
}

/** Extracts the embedded content of a base64 CMS SignedData (the TRA/response). */
export function extractCmsContent(base64Cms: string): string {
  const der = Buffer.from(base64Cms, "base64");
  const msg = forge.pkcs7.messageFromAsn1(
    forge.asn1.fromDer(der.toString("binary")),
  );
  return Buffer.from(msg.rawCapture.content.value[0].value, "binary").toString(
    "utf8",
  );
}

/** Builds the `loginCms` SOAP request envelope around a base64 CMS. */
export function buildLoginCmsEnvelope(base64Cms: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="${WSAA_NAMESPACE}">` +
    "<soapenv:Header/>" +
    "<soapenv:Body>" +
    "<wsaa:loginCms>" +
    `<wsaa:in0>${base64Cms}</wsaa:in0>` +
    "</wsaa:loginCms>" +
    "</soapenv:Body>" +
    "</soapenv:Envelope>"
  );
}

/** Extracts the XML ticket string in `loginCmsReturn` from the SOAP response. */
export function parseLoginCmsResponse(soapXml: string): string {
  const parsed = XML_PARSER().parse(soapXml) as {
    Envelope?: { Body?: { loginCmsResponse?: { loginCmsReturn?: unknown } } };
  };
  const ret = parsed?.Envelope?.Body?.loginCmsResponse?.loginCmsReturn;
  if (typeof ret !== "string") {
    throw new Error("loginCmsReturn not found in WSAA SOAP response");
  }
  return ret;
}

/** Parses the `loginTicketResponse` XML (extracted from the CMS) into a TA. */
export function parseLoginTicketResponse(xml: string): WsaaTa {
  const parsed = XML_PARSER().parse(xml) as {
    loginTicketResponse?: {
      header?: { expirationTime?: unknown };
      credentials?: { token?: unknown; sign?: unknown };
    };
  };
  const header = parsed?.loginTicketResponse?.header;
  const creds = parsed?.loginTicketResponse?.credentials;
  const expirationTime = header?.expirationTime;
  const token = creds?.token;
  const sign = creds?.sign;
  if (
    typeof token !== "string" ||
    typeof sign !== "string" ||
    typeof expirationTime !== "string"
  ) {
    throw new Error("Malformed loginTicketResponse");
  }
  return { token, sign, expirationTime };
}

/**
 * A credentials source. Either the static PEM pair, or a provider that decrypts
 * the private key just-in-time (the production path: the `credentials` table
 * stores the key AES-encrypted, and `AES_KEY` unlocks it only when needed).
 */
export type WsaaCredentialsProvider = WsaaCredentials | (() => Promise<WsaaCredentials>);

export interface WsaaClientOptions {
  url: string;
  credentials: WsaaCredentialsProvider;
  transport: WsaaTransport;
  /** Injectable clock (default: real). */
  clock?: () => Date;
  /** Injectable uniqueId provider (default: monotonic counter). */
  uniqueIdProvider?: () => string;
  /**
   * TRA (Login Ticket Request) validity window in MINUTES (default 5). The TRA
   * window is minutes — NOT the 12h TA lifetime ARCA returns in the ticket.
   */
  traTtlMinutes?: number;
  logger?: ArcaLogger;
  metrics?: ArcaMetrics;
}

/** Default TRA validity window (minutes). */
export const DEFAULT_TRA_TTL_MINUTES = 5;

// WSAA specifies xsd:unsignedInt, not an arbitrary integer. Epoch seconds fit
// the 32-bit range; milliseconds do not. Advance for repeated calls, wrapping
// only at the unsigned boundary (generationTime also identifies the request).
let lastUniqueId = 0;
export function defaultUniqueId(): string {
  const now = Math.floor(Date.now() / 1000);
  lastUniqueId = (now > lastUniqueId ? now : lastUniqueId + 1) % 0x100000000;
  return String(lastUniqueId);
}

/** Resolves a `WsaaCredentialsProvider` to a concrete PEM pair. */
async function resolveCredentials(
  provider: WsaaCredentialsProvider,
): Promise<WsaaCredentials> {
  return typeof provider === "function" ? provider() : provider;
}

/** WSAA client: `loginCms(service)` returns the TA for that service. */
export class WsaaClient {
  private readonly url: string;
  private readonly credentials: WsaaCredentialsProvider;
  private readonly transport: WsaaTransport;
  private readonly clock: () => Date;
  private readonly uniqueIdProvider: () => string;
  private readonly traTtlMinutes: number;
  private readonly logger: ArcaLogger;
  private readonly metrics: ArcaMetrics;

  constructor(options: WsaaClientOptions) {
    this.url = options.url;
    this.credentials = options.credentials;
    this.transport = options.transport;
    this.clock = options.clock ?? (() => new Date());
    this.uniqueIdProvider = options.uniqueIdProvider ?? defaultUniqueId;
    this.traTtlMinutes = options.traTtlMinutes ?? DEFAULT_TRA_TTL_MINUTES;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
  }

  async loginCms(service: string): Promise<WsaaTa> {
    const started = Date.now();
    const now = this.clock();
    const generationTime = formatWsaaTime(now);
    const expiration = new Date(
      now.getTime() + this.traTtlMinutes * 60 * 1000,
    );
    const expirationTime = formatWsaaTime(expiration);
    const tra = buildTra({
      uniqueId: this.uniqueIdProvider(),
      generationTime,
      expirationTime,
      service,
    });
    const credentials = await resolveCredentials(this.credentials);
    const cms = signTraCms(credentials, tra);
    const envelope = buildLoginCmsEnvelope(cms);
    const response = await this.transport.post(this.url, envelope, SOAP_HEADERS);
    let ta: WsaaTa;
    try {
      const ticket = parseLoginCmsResponse(response).trim();
      // WSAA returns escaped XML (or CDATA), NOT a signed CMS response. Keep
      // compatibility with the older CMS fixtures without assuming it on wire.
      const ticketXml = ticket.startsWith("<") ? ticket : extractCmsContent(ticket);
      ta = parseLoginTicketResponse(ticketXml);
    } catch { throw new ArcaQueryError("wsaa", "malformed-response"); }
    this.metrics.increment("wsaa_login_success");
    this.logger.info("wsaa_login_success", {
      service,
      duration_ms: Date.now() - started,
      tra_ttl_minutes: this.traTtlMinutes,
    });
    return ta;
  }
}
