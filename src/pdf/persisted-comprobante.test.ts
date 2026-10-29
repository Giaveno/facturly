import { expect, it } from "vitest";
import { createTestDb } from "@/test-support/test-db";
import { clients, comprobantes } from "@/lib/db/schema";
import { loadApprovedComprobantePdfInput } from "@/lib/invoices/read-model";
import { buildComprobantePdfModel, renderInvoicePdf } from "./render";

it("renders the exact approved row shape persisted by the emission service", async () => {
  const { db, close } = await createTestDb();
  try {
    const [company] = await db.insert(clients).values({ cuit: "33693450239", razonSocial: "PRUEBA ARCA WSFE", ptoVta: 1, condicionIva: "ri" }).returning();
    if (!company) throw new Error("Missing test company");
    const [row] = await db.insert(comprobantes).values({
      empresaId: company.id, ambiente: "homologacion", emisorCuit: company.cuit, emisorCondicionIva: "ri",
      cbteTipo: 6, ptoVta: 1, cbteNro: 109, concepto: 1, docTipo: 99, docNro: "0", condicionIvaReceptor: 5,
      fecha: "2026-10-29", importeNetoCentavos: 100000, importeIvaCentavos: 21000,
      importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 121000,
      items: [{ descripcion: "Prueba", netoCentavos: 100000, ivaCentavos: 21000, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 121000, alicuota: 21 }],
      estado: "aprobado", cae: "86441033082760", caeVto: "2026-11-08", resultado: "A", idempotencyKey: "pdf-regression",
    }).returning();
    if (!row) throw new Error("Missing test comprobante");
    const input = await loadApprovedComprobantePdfInput(db, row.id, company.id);
    expect(input).not.toBeNull();
    const model = buildComprobantePdfModel(input!);
    expect(model.lines).toContainEqual({ label: "Número", value: "00001-00000109" });
    const note = buildComprobantePdfModel({ ...input!, cbteTipo: 8, associated: { cbteTipo: 6, ptoVta: 1, cbteNro: 109 } });
    expect(note.lines).toContainEqual({ label: "Comprobante asociado", value: "6 00001-00000109" });
    const pdf = await renderInvoicePdf(model);
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
  } finally { await close(); }
});
