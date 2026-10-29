/** Explicit operator-authorized one-shot homologation task; never retry this task. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

async function main() {
  process.loadEnvFile(".env");
  if (process.env.ARCA_ENV !== "homologacion" || process.env.EMISSIONS_ENABLED !== "true") throw new Error("Requires homologacion and EMISSIONS_ENABLED=true");
  mkdirSync(".data", { recursive: true });
  const marker = ".data/prueba-cuit-propio.started.json";
  if (existsSync(marker)) throw new Error("Task already started; refusing retry");
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { eq } = await import("drizzle-orm");
  const schema = await import("../src/lib/db/schema");
  const { buildArcaGateway } = await import("../src/lib/emission/gateway");
  const { emitComprobante } = await import("../src/lib/emission/comprobante-emission-service");
  const { loadApprovedComprobantePdfInput } = await import("../src/lib/invoices/read-model");
  const { buildComprobantePdfModel, renderInvoicePdf } = await import("../src/pdf/render");
  const { XMLParser } = await import("fast-xml-parser");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const counts = { wsaa: 0, ultimoAutorizado: 0, emitir: 0, consultar: 0 };
  const originalFetch = globalThis.fetch;
  let issued = false;
  globalThis.fetch = async (url, options) => {
    const body = String(options?.body ?? "");
    if (String(url).includes("wsaa")) counts.wsaa++;
    else if (body.includes("FECompUltimoAutorizado")) counts.ultimoAutorizado++;
    else if (body.includes("FECAESolicitar")) { if (issued) throw new Error("Second issuance prohibited"); issued = true; counts.emitir++; }
    else if (body.includes("FECompConsultar")) counts.consultar++;
    const response = await originalFetch(url, options);
    if (!String(url).includes("wsaa")) {
      const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(await response.clone().text());
      const responseBody = parsed.Envelope?.Body;
      const last = responseBody?.FECompUltimoAutorizadoResponse?.FECompUltimoAutorizadoResult;
      if (last) console.log(JSON.stringify({ stage: "ultimo-response", httpStatus: response.status, cbteNro: last.CbteNro, errors: last.Errors?.Err }));
      if (responseBody?.Fault) console.log(JSON.stringify({ stage: "soap-fault", faultcode: responseBody.Fault.faultcode, faultstring: responseBody.Fault.faultstring }));
    }
    return response;
  };
  try {
    const [company] = await db.select().from(schema.clients).where(eq(schema.clients.cuit, "20436027525"));
    if (!company || company.condicionIva !== "exento" || company.ptoVta !== 1) throw new Error("Expected own CUIT registered as exento/PV1");
    writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString(), cuit: company.cuit }), { flag: "wx" });
    const gateway = buildArcaGateway(db, process.env);
    const last = await gateway.ultimoAutorizado(company.cuit, 1, 11);
    console.log(JSON.stringify({ stage: "readonly-last", result: last }));
    if (!Number.isInteger(last) || last < 0) throw new Error("Invalid last authorized number; emission prohibited");
    const result = await emitComprobante({ db, gateway, env: process.env }, {
      empresaId: company.id, emisorCuit: company.cuit, emisorCondicionIva: "exento", cbteTipo: 11, ptoVta: 1,
      concepto: 1, docTipo: 99, docNro: "0", condicionIvaReceptor: 5,
      fecha: new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }),
      importeNetoCentavos: 100000, importeIvaCentavos: 0, importeExentoCentavos: 0, importeTributosCentavos: 0, importeTotalCentavos: 100000,
      items: [{ descripcion: "Prueba de homologación", netoCentavos: 100000, ivaCentavos: 0, exentoCentavos: 0, tributosCentavos: 0, totalCentavos: 100000, alicuota: 0 }],
      idempotencyKey: randomUUID(),
    });
    console.log(JSON.stringify({ stage: "emission", result }));
    if (result.estado !== "aprobado" || !result.cbteNro) throw new Error(`Emission not approved: ${result.errores ?? result.estado}`);
    const input = await loadApprovedComprobantePdfInput(db, result.id, company.id);
    if (!input) throw new Error("Approved PDF input unavailable");
    const verified = await gateway.consultInvoice!({ cuit: company.cuit, ptoVta: 1, cbteTipo: 11, cbteNro: result.cbteNro,
      receptorDocTipo: 99, receptorDocNro: 0, condicionIvaReceptorId: 5, receptorRazonSocial: "Consumidor Final",
      fechaEmision: input.fecha, fechaVto: input.fecha, moneda: "PES", cotizacion: 1,
      importeNeto: 100000, importeIva: 0, importeTotal: 100000, taxRate: 0 });
    if (!verified || verified.cae !== result.cae || verified.cbteNro !== result.cbteNro) throw new Error("Consultation mismatch");
    console.log(JSON.stringify({ stage: "verified", verified }));
    const path = `.data/factura-c-propia-${result.cbteNro}.pdf`;
    writeFileSync(path, await renderInvoicePdf(buildComprobantePdfModel(input)));
    console.log(JSON.stringify({ stage: "pdf", path }));
  } finally { console.log(JSON.stringify({ calls: counts })); globalThis.fetch = originalFetch; await pool.end(); }
}
main().catch((error: unknown) => {
  const e = error as Error & { code?: string; diagnostic?: unknown; providerCodes?: unknown };
  console.error(JSON.stringify({ ok: false, error: { name: e.name, message: e.message, code: e.code, diagnostic: e.diagnostic, providerCodes: e.providerCodes, stack: e.stack } }));
  process.exitCode = 1;
});
