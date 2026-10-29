import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } from "./constants";
import { escapeXml } from "./xml";
import type { SoapResponseMetadata } from "./http";
import { parseSoapFault } from "./errors";

const OMITTED = "[SOAP omitted: unsafe XML]";
const protectedName = (name: string) => /^(auth|credentials|token|sign|in0|logincmsreturn|cms|cert(pem|ificate)?|key(pem)?|privatekey(pem)?|password|secret|signature|certificatechain)$/i.test(name.split(":").at(-1) ?? "");
/** Fixed one-level encodings, never decode provider text or recursively expand. */
function secretVariants(secrets: readonly string[]): string[] {
  if (secrets.length > 128) throw Error("Secret redaction bounds exceeded");
  const variants = new Set<string>();
  let total = 0;
  const add = (value: string) => {
    if (!value || variants.has(value)) return;
    total += value.length;
    if (total > 8_388_608 || variants.size >= 8192) throw Error("Secret redaction bounds exceeded");
    variants.add(value);
  };
  for (const secret of secrets.filter(Boolean)) {
    if (secret.length > 1_048_576) throw Error("Secret redaction bounds exceeded");
    const bases = new Set([secret]);
    for (const match of secret.matchAll(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/g)) {
      const lines = match[1]!.trim().split(/\s+/).filter(Boolean);
      // A bare PEM reflection may omit markers and wrap its short final line.
      bases.add(lines.join(""));
      for (const line of lines) bases.add(line);
    }
    for (const base of bases) {
      const uri = encodeURIComponent(base), base64 = Buffer.from(base, "utf8").toString("base64");
      for (const value of [base, uri, uri.replace(/%[0-9a-f]{2}/gi, part => part.toLowerCase()), base64, base64.replace(/=+$/, ""), Buffer.from(base, "utf8").toString("base64url")]) {
        add(value); add(escapeXml(value)); add(escapeXml(escapeXml(value)));
      }
    }
  }
  return [...variants].sort((a,b) => b.length-a.length);
}
/** No raw fallback. Parse before editing, discard comments, then rebuild bounded XML. */
export function redactSoap(xml: string, secrets: readonly string[]): string {
  if (xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return OMITTED;
  try {
    const variants = secretVariants(secrets);
    const pemBodies = secrets.flatMap(secret => [...secret.matchAll(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/g)].map(match => match[1]!.replace(/\s/g,""))).filter(Boolean);
    const cleanText = (value: string) => {
      // Omit the whole value if a known PEM body was reflowed: substring
      // replacement of source-width lines could otherwise leave a short tail.
      const compact = value.replace(/\s/g,"");
      if (pemBodies.some(body => compact.includes(body))) return "[REDACTED]";
      let result = value.replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, "[REDACTED]");
      for (const secret of variants) result = result.split(secret).join("[REDACTED]");
      return result;
    };
    const clean = (value: unknown): unknown => {
      if (typeof value === "string") return cleanText(value);
      if (Array.isArray(value)) return value.map(clean).filter(item => typeof item !== "object" || item === null || Object.keys(item).length > 0);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
        if (key === "#comment" || protectedName(key.replace(/^@_/, ""))) return [];
        return [[key, clean(child)]];
      }));
      return value;
    };
    const options = { preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, commentPropName: "#comment", cdataPropName: "#text" };
    const parsed: unknown = new XMLParser(options).parse(xml);
    return new XMLBuilder(options).build(clean(parsed));
  } catch { return OMITTED; }
}

/** Fault text is untrusted: remove credential reflections, assignments and blobs. */
function safeFaultText(value: string | undefined, code = false): string | undefined {
  if (!value) return;
  // Never partially print an unknown wrapped blob with an unrecognized tail.
  if (/[A-Za-z0-9+/_=-]{64,}/.test(value)) return "[REDACTED: credential-like fault text]";
  const clean = value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, "[REDACTED]")
    .replace(/\b(token|sign|password|secret|signature|cms|privatekey|cert(?:ificate)?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z0-9+/_=-]{64,}/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  if (code) return /^[A-Za-z0-9_.:\-]{1,160}$/.test(clean) ? clean : "[fault code omitted]";
  return clean.length <= 512 ? clean : "[fault text omitted: too long]";
}

/** Explicit console-only opt-in. WSAA emits fault fields only, never a response body. */
export function createHomologacionCapture(options: {
  environment: string | undefined; enabled: boolean; secrets: () => readonly string[]; write: (text: string) => void;
}): (direction: "request" | "response", url: string, xml: string, metadata?: SoapResponseMetadata) => void {
  const discovered = new Set<string>();
  return (direction, url, xml, metadata) => {
    if (options.environment !== "homologacion" || !options.enabled || ![WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL].includes(url)) return;
    if (direction === "request" && xml.length <= 1_048_576 && !/<!DOCTYPE|<!ENTITY/i.test(xml) && XMLValidator.validate(xml) === true) {
      try {
        const collect = (value: unknown): void => {
          if (Array.isArray(value)) { value.forEach(collect); return; }
          if (!value || typeof value !== "object") return;
          for (const [name, child] of Object.entries(value)) {
            if (protectedName(name) && typeof child === "string" && child) discovered.add(child);
            else collect(child);
          }
        };
        collect(new XMLParser({ignoreAttributes:false,parseTagValue:false,removeNSPrefix:true}).parse(xml));
      } catch { /* Unsafe input is omitted by the redactor. */ }
    }
    const safeMetadata = metadata ? {
      httpStatus: Number.isSafeInteger(metadata.httpStatus) && metadata.httpStatus >= 100 && metadata.httpStatus <= 599 ? metadata.httpStatus : 0,
      mediaType: ["text/xml","application/soap+xml","application/xml","text/html","text/plain"].includes(metadata.mediaType) ? metadata.mediaType : "other",
      shape: ["html","xml","empty"].includes(metadata.shape) ? metadata.shape : "other",
    } : undefined;
    const redacted = redactSoap(xml, [...options.secrets(), ...discovered]);
    if (direction === "response" && url === WSAA_HOMOLOGACION_URL) {
      // Never output loginCmsReturn, credentials, fault detail, or raw/invalid XML.
      // Only parse the already validated/redacted envelope, with no raw fallback.
      if (redacted === OMITTED) return;
      const fault = parseSoapFault(redacted);
      if (!fault) return;
      options.write(`wsaa-fault ${JSON.stringify({...safeMetadata, faultcode:safeFaultText(fault.faultcode,true), faultstring:safeFaultText(fault.faultstring)})}`);
      return;
    }
    options.write(`${direction} ${url}${safeMetadata ? ` ${JSON.stringify(safeMetadata)}` : ""}\n${redacted}`);
  };
}
