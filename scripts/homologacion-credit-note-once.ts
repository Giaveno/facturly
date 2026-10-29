/** One-shot operator task: never retry automatically or run against another issuer. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

async function main() {
  process.loadEnvFile(".env");
  if (process.env.ARCA_ENV !== "homologacion" || process.env.EMISSIONS_ENABLED !== "true") throw new Error("Requires homologacion and EMISSIONS_ENABLED=true");
  mkdirSync(".data", { recursive: true });
  const marker = ".data/prueba-nc.started.json";
  if (existsSync(marker)) throw new Error("One-shot credit note task already started; refusing to retry");
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { and, eq } = await import("drizzle-orm");
  const schema = await import("../src/lib/db/schema");
  const { emitComprobante } = await import("../src/lib/emission/comprobante-emission-service");
  const { buildArcaGateway } = await import("../src/lib/emission/gateway");
  const { loadApprovedComprobantePdfInput } = await import("../src/lib/invoices/read-model");
  const { buildComprobantePdfModel, renderInvoicePdf } = await import("../src/pdf/render");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const counts = { wsaa: 0, ultimoAutorizado: 0, emitir: 0, consultar: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = String(options?.body ?? "");
    if (String(url).includes("wsaa")) counts.wsaa++;
    else if (body.includes("FECompUltimoAutorizado")) counts.ultimoAutorizado++;
    else if (body.includes("FECAESolicitar")) counts.emitir++;
    else if (body.includes("FECompConsultar")) counts.consultar++;
    return originalFetch(url, options);
  };
  try {
    const c = schema.comprobantes;
    const [original] = await db.select().from(c).where(and(eq(c.ambiente, "homologacion"), eq(c.emisorCuit, "33693450239"), eq(c.ptoVta, 1), eq(c.cbteTipo, 6), eq(c.cbteNro, 109), eq(c.estado, "aprobado")));
    if (!original) throw new Error("Approved sandbox Factura B109 not found");
    const existing = await db.select({ id: c.id }).from(c).where(eq(c.comprobanteAsociadoId, original.id));
    if (existing.length) throw new Error("Original already has credit note attempts; refusing another emission");
    writeFileSync(marker, JSON.stringify({ originalId: original.id, startedAt: new Date().toISOString() }), { flag: "wx" });
    const gateway = buildArcaGateway(db, process.env);
    const result = await emitComprobante({ db, gateway, env: process.env }, {
      empresaId: original.empresaId, emisorCuit: original.emisorCuit, emisorCondicionIva: original.emisorCondicionIva,
      cbteTipo: 8, ptoVta: 1, concepto: original.concepto, docTipo: original.docTipo, docNro: original.docNro,
      condicionIvaReceptor: original.condicionIvaReceptor!, fecha: new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }),
      importeNetoCentavos: original.importeNetoCentavos!, importeIvaCentavos: original.importeIvaCentavos!,
      importeExentoCentavos: original.importeExentoCentavos!, importeTributosCentavos: original.importeTributosCentavos!, importeTotalCentavos: original.importeTotalCentavos!,
      items: original.items as import("../src/domain/comprobantes").ComprobanteItem[], idempotencyKey: randomUUID(), comprobanteAsociadoId: original.id,
    });
    console.log(JSON.stringify({ stage: "emission", result }));
    if (result.estado !== "aprobado" || !result.cbteNro) throw new Error(`Credit note not approved: ${result.errores ?? result.estado}`);
    const loaded = await loadApprovedComprobantePdfInput(db, result.id, original.empresaId);
    if (!loaded) throw new Error("Approved credit note PDF snapshot unavailable");
    const verified = await gateway.consultInvoice!({ cuit: original.emisorCuit, ptoVta: 1, cbteTipo: 8, cbteNro: result.cbteNro,
      receptorDocTipo: loaded.docTipo, receptorDocNro: Number(loaded.docNro), condicionIvaReceptorId: loaded.condicionIvaReceptor,
      receptorRazonSocial: loaded.receptorRazonSocial, fechaEmision: loaded.fecha, fechaVto: loaded.fecha, moneda: "PES", cotizacion: 1,
      importeNeto: loaded.importeNetoCentavos, importeIva: loaded.importeIvaCentavos, importeTotal: loaded.importeTotalCentavos,
      taxRate: 21, cbtesAsoc: [{ tipo: 6, ptoVta: 1, nro: 109 }] });
    if (!verified || verified.cae !== result.cae || verified.cbteNro !== result.cbteNro) throw new Error("FECompConsultar did not match issued credit note");
    console.log(JSON.stringify({ stage: "verified", verified }));
    for (const [id, name] of [[original.id, "factura-b-109"], [result.id, `nota-credito-b-${result.cbteNro}`]]) {
      const input = await loadApprovedComprobantePdfInput(db, id!, original.empresaId);
      if (!input) throw new Error("Approved PDF snapshot unavailable");
      const path = `.data/${name}.pdf`;
      writeFileSync(path, await renderInvoicePdf(buildComprobantePdfModel(input)));
      console.log(JSON.stringify({ stage: "pdf", path }));
    }
  } finally {
    console.log(JSON.stringify({ calls: counts }));
    globalThis.fetch = originalFetch;
    await pool.end();
  }
}
main().catch((error: unknown) => {
  const e = error as Error & { code?: string; providerCodes?: unknown };
  console.error(JSON.stringify({ ok: false, error: { name: e.name, message: e.message, code: e.code, providerCodes: e.providerCodes, stack: e.stack } }));
  process.exitCode = 1;
});
