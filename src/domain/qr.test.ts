import { describe, it, expect } from "vitest";
import {
  buildQrPayload,
  buildQrUrl,
  decodeQrPayload,
  QR_BASE_URL,
  type QrData,
} from "./qr";

// Official base URL per RG 4892 "QR Especificaciones" (formerly AFIP).
const OFFICIAL_BASE_URL = "https://www.arca.gob.ar/fe/qr/?p=";

const sample: QrData = {
  ver: 1,
  fecha: "2020-10-13",
  cuit: 30000000007,
  ptoVta: 10,
  tipoCmp: 1,
  nroCmp: 94,
  importe: 12100,
  moneda: "PES",
  ctz: 1,
  tipoDocRec: 80,
  nroDocRec: 20000000001,
  tipoCodAut: "E",
  codAut: 70417054367476,
};

/** Extracts the base64 payload from a built QR URL and decodes it. */
function decodeUrl(url: string): QrData {
  const payload = url.split("?p=")[1];
  if (payload === undefined) {
    throw new Error("QR URL is missing its base64 payload");
  }
  return decodeQrPayload(payload);
}

describe("qr — RG 4892 payload", () => {
  it("builds the JSON payload with exactly the 13 required fields", () => {
    const json = buildQrPayload(sample);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "ver",
        "fecha",
        "cuit",
        "ptoVta",
        "tipoCmp",
        "nroCmp",
        "importe",
        "moneda",
        "ctz",
        "tipoDocRec",
        "nroDocRec",
        "tipoCodAut",
        "codAut",
      ].sort(),
    );
  });

  it("produces the exact official URL with a raw base64 payload", () => {
    expect(QR_BASE_URL).toBe(OFFICIAL_BASE_URL);
    // Independent oracle: the canonical base64 of the sample payload, derived
    // from the RG 4892 field spec (13 fields, `importe` = currency units) —
    // NOT computed by the implementation under test. If the encoding were
    // wrong (URL-safe alphabet, URL-encoding, wrong byte order), this literal
    // mismatch would catch it.
    const EXPECTED_BASE64 =
      "eyJ2ZXIiOjEsImZlY2hhIjoiMjAyMC0xMC0xMyIsImN1aXQiOjMwMDAwMDAwMDA3LCJwdG9WdGEiOjEwLCJ0aXBvQ21wIjoxLCJucm9DbXAiOjk0LCJpbXBvcnRlIjoxMjEwMCwibW9uZWRhIjoiUEVTIiwiY3R6IjoxLCJ0aXBvRG9jUmVjIjo4MCwibnJvRG9jUmVjIjoyMDAwMDAwMDAwMSwidGlwb0NvZEF1dCI6IkUiLCJjb2RBdXQiOjcwNDE3MDU0MzY3NDc2fQ==";
    expect(buildQrUrl(sample)).toBe(OFFICIAL_BASE_URL + EXPECTED_BASE64);
    expect(decodeQrPayload(EXPECTED_BASE64)).toEqual(sample);
  });

  it("round-trips: encode → decode → every field preserved", () => {
    const decoded = decodeUrl(buildQrUrl(sample));
    expect(decoded).toEqual(sample);
  });

  it("transmits decimal currency units, including fractional cents precision", () => {
    expect(decodeUrl(buildQrUrl({...sample,importe:6250})).importe).toBe(6250);
    expect(decodeUrl(buildQrUrl({...sample,importe:6250.01})).importe).toBe(6250.01);
    expect(decodeUrl(buildQrUrl({...sample,importe:0.01})).importe).toBe(0.01);
  });

  it("tipoCodAut is always 'E' (CAE)", () => {
    const decoded = decodeUrl(buildQrUrl(sample));
    expect(decoded.tipoCodAut).toBe("E");
  });
});
