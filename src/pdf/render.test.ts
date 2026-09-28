import { describe, it, expect } from "vitest";
import { decodeQrPayload, QR_BASE_URL } from "@/domain/qr";
import {
  buildInvoicePdfModel,
  buildInvoiceQrData,
  buildInvoiceQrUrl,
  renderInvoicePdf,
  type InvoicePdfInput,
} from "./render";

const base: InvoicePdfInput = {
  cuit: "20123456789",
  ptoVta: 1,
  cbteTipo: 1,
  cbteNro: 7,
  cae: "70000000000007",
  caeFchVto: "2026-10-02",
  fechaEmision: "2026-09-22",
  importeTotal: 121000,
  moneda: "PES",
  receptorDocTipo: 80, // CUIT — the receptor is identified by their CUIT
  receptorDocNro: 30710145764,
  condicionIvaReceptorId: 6, // monotributista (RG 5616) — drives the legend
  receptorRazonSocial: "PAGADOR S.A.",
};

describe("invoice PDF — RG 4892 QR + CAE + due date + Ley 27.618 legend", () => {
  it("round-trips every QR field (raw base64, not URL-encoded)", () => {
    const url = buildInvoiceQrUrl(base);
    expect(url.startsWith(QR_BASE_URL)).toBe(true);
    const base64 = url.slice(QR_BASE_URL.length);
    // RAW base64 — must not contain URL-encoding characters.
    expect(base64).not.toMatch(/%[0-9A-Fa-f]{2}/);

    const decoded = decodeQrPayload(base64);
    expect(decoded).toEqual({
      ver: 1,
      fecha: "2026-09-22",
      cuit: 20123456789,
      ptoVta: 1,
      tipoCmp: 1,
      nroCmp: 7,
      importe: 121000,
      moneda: "PES",
      ctz: 1,
      tipoDocRec: 80,
      nroDocRec: 30710145764,
      tipoCodAut: "E",
      codAut: 70000000000007,
    });
  });

  it("buildInvoiceQrData carries the CAE and due date in the payload", () => {
    const data = buildInvoiceQrData(base);
    expect(String(data.codAut)).toBe(base.cae);
    expect(data.importe).toBe(base.importeTotal);
  });

  it("includes the Ley 27.618 legend only for RI → Monotributista", () => {
    // The legend is derived from the POLICY decision (condicionIvaReceptorId),
    // NOT from the document type — a monotributista is DocTipo 80 (CUIT) but
    // their IVA condition is 6.
    expect(buildInvoicePdfModel(base).includesLey27618Legend).toBe(true);
    // RI → RI (condition id 1, same DocTipo 80) is also Factura A but NO legend.
    expect(
      buildInvoicePdfModel({ ...base, condicionIvaReceptorId: 1 })
        .includesLey27618Legend,
    ).toBe(false);
    // RI → Consumidor Final (Factura B, DocTipo 99, condition id 5) — no legend.
    expect(
      buildInvoicePdfModel({
        ...base,
        cbteTipo: 6,
        receptorDocTipo: 99,
        receptorDocNro: 0,
        condicionIvaReceptorId: 5,
      }).includesLey27618Legend,
    ).toBe(false);
  });

  it("the content model carries the CAE, due date, and invoice data", () => {
    const model = buildInvoicePdfModel(base);
    const values = model.lines.map((l) => l.value);
    expect(values).toContain(base.cae);
    expect(values).toContain(base.caeFchVto);
    expect(values).toContain("1210.00"); // formatCentavos(121000)
    expect(values).toContain("PAGADOR S.A.");
  });

  it("renders a valid PDF and encodes the exact QR URL (injected encoder)", async () => {
    const model = buildInvoicePdfModel(base);
    let encodedUrl = "";
    const pdf = await renderInvoicePdf(model, async (url) => {
      encodedUrl = url;
      // A tiny 1×1 PNG is enough to prove embed works; the payload is verified
      // at the URL level above.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      );
      return new Uint8Array(png);
    });

    // The encoder received the exact URL the model built.
    expect(encodedUrl).toBe(model.qrUrl);
    // Valid PDF: header and EOF marker.
    expect(pdf[0]).toBe(0x25); // '%'
    const bytes = Buffer.from(pdf);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(bytes.toString("ascii")).toContain("%%EOF");
  });
});
