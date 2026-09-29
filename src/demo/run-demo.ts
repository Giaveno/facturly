/**
 * Offline demo driver — runs the WHOLE invoicing flow (upload → async OCR →
 * review → approve → emit → PDF/Excel → QR) against PGlite + fake adapters, with
 * NO credentials, NO network, and NO manual setup.
 *
 * The CLI entry is `scripts/demo.ts` (`pnpm demo`); the smoke test
 * (`src/demo/run-demo.test.ts`) calls `runDemo` in-process with a temp output
 * dir and asserts the key outcomes so CI proves the demo works even if no human
 * ever runs it.
 *
 * Determinism: the CAE expiry and emission dates come from an injected clock
 * (default fixed `2026-09-22`), so the narrated output is stable across runs and
 * no `Date.now()` leaks into the assertions.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createPgliteDb } from "@/lib/db/pglite";
import { ArcaGatewayFake } from "@/adapters/arca/arca-gateway.fake";
import { OcrFake } from "@/adapters/ocr/ocr.fake";
import { queueUpload, type UploadImage } from "@/lib/pipeline/ingest";
import { processOcrRow } from "@/lib/ocr/process";
import {
  approveInvoice,
  markInvoiceReviewed,
  materializeInvoice,
  rejectInvoice,
} from "@/lib/review/workflow";
import { listReviewRows } from "@/lib/review/read-model";
import {
  emitBatch,
  emitInvoice,
  NumberAllocator,
} from "@/lib/emission/emission-service";
import { listExportRows, exportRowsToXlsx } from "@/adapters/export";
import {
  buildInvoicePdfModel,
  buildInvoiceQrUrl,
  renderInvoicePdf,
  type InvoicePdfInput,
} from "@/pdf/render";
import { decodeQrPayload, QR_BASE_URL, type QrData } from "@/domain/qr";
import {
  cbteTipo,
  type CbteTipo,
  type CondicionIVA,
} from "@/domain/policy";
import { formatCentavos } from "@/domain/money";
import {
  clients,
  delegations,
  invoices,
  issuedInvoices,
  ocrRows,
} from "@/lib/db/schema";
import { RowNotEmittableError } from "@/domain/emission";
import type { ArcaGateway } from "@/ports/arca-gateway";
import type { OcrProvider } from "@/ports/ocr-provider";

const FIXED_NOW = () => new Date("2026-09-22T12:00:00.000Z");

/** The demo's client company (an RI emisor). */
const CLIENT = {
  cuit: "20123456789",
  razonSocial: "ESTUDIO CONTABLE DEL SUR S.A.",
  ptoVta: 1,
  condicionIva: "ri" as const,
};

/** Fake Padrón A5 conditions — which CUIT resolves to which IVA condition. */
const CONDITIONS: ReadonlyMap<string, CondicionIVA> = new Map([
  // ACME S.A. — the confident receipt's payer (Monotributista → Factura A + legend).
  ["23000000809", "monotributista"],
  ["20123456786", "ri"],
  ["30717336905", "exento"],
]);

const CONDITION_LABEL: Record<CondicionIVA | "unresolved", string> = {
  ri: "Responsable Inscripto",
  monotributista: "Monotributista",
  exento: "Exento",
  consumidorFinal: "Consumidor Final",
  unresolved: "not in Padrón",
};

function cbteLabel(c: CbteTipo): string {
  return c === 1 ? "Factura A" : c === 6 ? "Factura B" : "Factura C";
}

/** A synthetic receipt "photo" — a single marker byte the OcrFake dispatches on. */
interface Receipt {
  storageKey: string;
  /** 0x00 confident, 0x01 low-confidence, else no-CUIT (see ocr.fake.ts). */
  marker: number;
  label: string;
}

const RECEIPTS: Receipt[] = [
  { storageKey: "acme-1.jpg", marker: 0x00, label: "ACME S.A. — service invoice" },
  { storageKey: "acme-2.jpg", marker: 0x00, label: "ACME S.A. — service invoice (2nd)" },
  { storageKey: "lowconf.jpg", marker: 0x01, label: "LEGIBLE? S.R.L. — blurred photo" },
  { storageKey: "delta.jpg", marker: 0x42, label: "PAGOS DELTA SRL — transfer, no CUIT" },
  { storageKey: "transfer.jpg", marker: 0x00, label: "ACME S.A. — non-sale transfer (own accounts)" },
];

export interface DemoOptions {
  /** Directory that receives the generated PDF(s) + Excel. */
  outputDir: string;
  /** Narration sink — defaults to console.log; the smoke test passes a no-op. */
  log?: (line: string) => void;
  /** Fixed clock (determinism). Defaults to a fixed 2026-09-22 date. */
  now?: () => Date;
  /** When true, also print the raw decoded QR payload (debug). */
  debug?: boolean;
}

export interface EmittedInvoice {
  invoiceId: string;
  cbteNro: number;
  cae: string;
  cbteTipo: CbteTipo;
  receptorRazonSocial: string;
  includesLegend: boolean;
}

export interface DemoResult {
  emitted: EmittedInvoice[];
  blockedRefused: boolean;
  blockedRefusalReason: string;
  flaggedReason: string;
  discardedReason: string;
  /** Decoded RG 4892 payload (13 fields) of the FIRST emitted invoice. */
  qr: QrData;
  files: string[];
  counts: { emitted: number; blocked: number; flagged: number; discarded: number };
}

export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const log = options.log ?? console.log;
  const now = options.now ?? FIXED_NOW;
  const step = (n: string, title: string) => log(`\n=== ${n} — ${title} ===`);

  mkdirSync(options.outputDir, { recursive: true });

  // ── Boot the offline stack ──────────────────────────────────────────────
  step("1", "Boot the offline stack (PGlite + fake ARCA + fake OCR + test session)");
  const { db, close } = await createPgliteDb();
  try {
    const gateway: ArcaGateway = new ArcaGatewayFake(CONDITIONS, now);
    const ocr: OcrProvider = new OcrFake();

    log("  Database:   PGlite (in-process Postgres) + full drizzle migrations");
    log("  ARCA:       fake gateway (deterministic, no credentials, no network)");
    log("  OCR:        fake OCR (marker-byte protocol, no model)");
    log("  Auth:       test session (stub — the real seam would deny)");

    // ── Seed client company + delegation + payers ──────────────────────────
    step("2", "Seed a client company and its emission authorization");
    const [client] = await db.insert(clients).values(CLIENT).returning();
    await db
      .insert(delegations)
      .values({ clientId: client!.id, cuit: CLIENT.cuit, enabled: true });
    log(`  Client:    ${CLIENT.razonSocial} (CUIT ${CLIENT.cuit})`);
    log("  Condition: Responsable Inscripto (emits Factura A/B)");
    log("  Delegation: wsfe enabled → this client may emit");

    // ── Upload + async OCR ─────────────────────────────────────────────────
    step("3", "Upload receipt photos and run async OCR");
    const images: UploadImage[] = RECEIPTS.map((r) => ({
      storageKey: r.storageKey,
      image: new Uint8Array([r.marker]),
    }));
    const imageMap = new Map(images.map((i) => [i.storageKey, i.image]));
    const getImage = (key: string): Promise<Uint8Array> => {
      const img = imageMap.get(key);
      if (!img) throw new Error(`demo: no image for storage key ${key}`);
      return Promise.resolve(img);
    };

    const uploaded = await queueUpload(client!.id, images, { db });
    const rowIds = uploaded.rows.map((r) => r.id);

    const invoicesByRow = new Map<string, string>();
    log("");
    for (let i = 0; i < RECEIPTS.length; i++) {
      const receipt = RECEIPTS[i]!;
      const rowId = rowIds[i]!;
      const promoted = await processOcrRow(db, ocr, rowId, getImage);
      const [row] = await db.select().from(ocrRows).where(eq(ocrRows.id, rowId));
      const inv = await materializeInvoice(db, rowId);
      invoicesByRow.set(receipt.storageKey, inv.id);

      const fields = row!.fields;
      const confPct = Object.entries(row!.confidence)
        .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
        .join(", ");
      log(`  ${receipt.label}`);
      log(
        `    → payer "${fields.name}", amount $${formatCentavos(fields.amount)}, date ${fields.date}`,
      );
      log(
        `    → OCR status: ${promoted.status}${row!.cuit ? `, CUIT ${row!.cuit}` : ", no CUIT"}`,
      );
      log(`    → confidence: ${confPct || "—"}`);
    }

    // ── Review table ───────────────────────────────────────────────────────
    step("4", "Review table (what the accountant sees)");
    const review = await listReviewRows(db);
    log(
      "  Payer                       Amount     Condition              Comprobante      Status",
    );
    for (const r of review) {
      let condition = "—";
      let cbte = "—";
      let status: string = r.status;
      if (r.status === "BLOCKED") {
        status = "BLOCKED (low confidence)";
      } else if (r.cuit) {
        const cond = await gateway.getIvaCondition(CLIENT.cuit, r.cuit);
        condition = cond === "unresolved" ? "unresolved" : CONDITION_LABEL[cond];
        if (cond !== "unresolved") {
          const d = cbteTipo(CLIENT.condicionIva, cond);
          cbte = cbteLabel(d.cbteTipo) + (d.requiresLey27618Legend ? " + Ley 27.618" : "");
        }
      } else {
        status = "FLAGGED (no CUIT)";
      }
      log(
        `  ${r.fields.name.padEnd(27)} $${formatCentavos(r.fields.amount).padStart(9)}  ` +
          `${condition.padEnd(21)}  ${cbte.padEnd(15)}  ${status}`,
      );
    }

    // ── Core fiscal logic (IVA condition → comprobante type) ───────────────
    step("5", "Fiscal logic — IVA condition (Padrón) → comprobante type");
    for (const [cuit] of CONDITIONS) {
      const cond = await gateway.getIvaCondition(CLIENT.cuit, cuit);
      const d = cbteTipo(CLIENT.condicionIva, cond as CondicionIVA);
      log(
        `  CUIT ${cuit} → ${CONDITION_LABEL[cond as CondicionIVA]} → ` +
          `${cbteLabel(d.cbteTipo)}${d.requiresLey27618Legend ? " (Ley 27.618 legend)" : ""}`,
      );
    }
    log("  (RI → Monotributista is Factura A + the Ley 27.618 legend — the easy-to-miss case)");

    // ── Approve the approvable rows ────────────────────────────────────────
    step("6", "Approve the approvable invoices");
    const acme1 = invoicesByRow.get("acme-1.jpg")!;
    const acme2 = invoicesByRow.get("acme-2.jpg")!;
    for (const invId of [acme1, acme2]) {
      await markInvoiceReviewed(db, invId);
      const approved = await approveInvoice(db, gateway, invId, now);
      const legend = approved.cbteTipo === 1 && approved.condicionIvaReceptorId === 6;
      log(
        `  Approved: ${approved.receptorRazonSocial} → ${cbteLabel(approved.cbteTipo as CbteTipo)}` +
          `${legend ? " + Ley 27.618 legend" : ""} ($${formatCentavos(approved.importeTotalCentavos ?? 0)})`,
      );
    }

    // ── Flag: no CUIT row is NOT approvable ────────────────────────────────
    step("7", "Flag — the no-CUIT row is not approvable");
    const deltaId = invoicesByRow.get("delta.jpg")!;
    await markInvoiceReviewed(db, deltaId);
    let flaggedReason = "";
    try {
      await approveInvoice(db, gateway, deltaId, now);
    } catch (err) {
      flaggedReason = err instanceof Error ? err.message : String(err);
      log(`  Refused: ${flaggedReason}`);
    }

    // ── Discard a non-sale transfer ────────────────────────────────────────
    step("8", "Discard a non-sale transfer");
    const transferId = invoicesByRow.get("transfer.jpg")!;
    const discarded = await rejectInvoice(
      db,
      transferId,
      "Transfer between the client's own accounts — not a sale",
    );
    log(`  Discarded with reason: "${discarded.discardReason}"`);

    // ── Guard: a BLOCKED row cannot emit ───────────────────────────────────
    step("9", "Guard — a BLOCKED row cannot be emitted");
    const blockedId = invoicesByRow.get("lowconf.jpg")!;
    const allocator = new NumberAllocator(gateway);
    let blockedRefused = false;
    let blockedRefusalReason = "";
    try {
      await emitInvoice(
        { db, gateway, emissionsEnabled: true, delayMs: 0 },
        allocator,
        blockedId,
      );
    } catch (err) {
      blockedRefused = err instanceof RowNotEmittableError;
      blockedRefusalReason = err instanceof Error ? err.message : String(err);
      log(`  Refused: ${blockedRefusalReason}`);
    }

    // ── Emit the batch ─────────────────────────────────────────────────────
    step("10", "Emit the approved invoices (batch) and print the CAEs");
    const results = await emitBatch(
      { db, gateway, emissionsEnabled: true, delayMs: 0 },
      [acme1, acme2],
    );
    const emitted: EmittedInvoice[] = [];
    for (const r of results) {
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, r.invoiceId));
      const [issued] = await db
        .select()
        .from(issuedInvoices)
        .where(eq(issuedInvoices.invoiceId, r.invoiceId));
      const legend = inv!.cbteTipo === 1 && inv!.condicionIvaReceptorId === 6;
      emitted.push({
        invoiceId: r.invoiceId,
        cbteNro: r.cbteNro!,
        cae: r.cae!,
        cbteTipo: inv!.cbteTipo as CbteTipo,
        receptorRazonSocial: inv!.receptorRazonSocial!,
        includesLegend: legend,
      });
      log(
        `  ${inv!.receptorRazonSocial}: ${cbteLabel(inv!.cbteTipo as CbteTipo)} #${r.cbteNro}` +
          `  CAE ${r.cae}  (valid until ${issued!.caeFchVto})${legend ? "  [Ley 27.618 legend]" : ""}`,
      );
    }

    // ── Render PDF + Excel ─────────────────────────────────────────────────
    step("11", "Render the invoice PDF(s) and the Excel export");
    const files: string[] = [];
    let qr: QrData | undefined;
    for (const e of emitted) {
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, e.invoiceId));
      const [issued] = await db
        .select()
        .from(issuedInvoices)
        .where(eq(issuedInvoices.invoiceId, e.invoiceId));
      const [owner] = await db.select().from(clients).where(eq(clients.id, inv!.clientId));
      const input: InvoicePdfInput = {
        cuit: owner!.cuit,
        ptoVta: owner!.ptoVta,
        cbteTipo: inv!.cbteTipo as CbteTipo,
        cbteNro: issued!.cbteNro,
        cae: issued!.cae!,
        caeFchVto: issued!.caeFchVto!,
        fechaEmision: inv!.fechaEmision!,
        importeTotal: inv!.importeTotalCentavos!,
        moneda: inv!.moneda!,
        receptorDocTipo: inv!.receptorDocTipo!,
        receptorDocNro: inv!.receptorDocNro!,
        condicionIvaReceptorId: inv!.condicionIvaReceptorId!,
        receptorRazonSocial: inv!.receptorRazonSocial!,
      };
      const model = buildInvoicePdfModel(input);
      const pdf = await renderInvoicePdf(model);
      const pdfPath = join(options.outputDir, `invoice-${issued!.cbteNro}.pdf`);
      writeFileSync(pdfPath, pdf);
      files.push(pdfPath);
      log(`  PDF:   ${pdfPath}`);
      if (!qr) qr = decodeQrPayload(buildInvoiceQrUrl(input).slice(QR_BASE_URL.length));
    }
    const xlsx = exportRowsToXlsx(await listExportRows(db));
    const xlsxPath = join(options.outputDir, "review.xlsx");
    writeFileSync(xlsxPath, xlsx);
    files.push(xlsxPath);
    log(`  Excel: ${xlsxPath}`);

    // ── Verify the QR (RG 4892 13-field payload) ───────────────────────────
    step("12", "Verify the QR — decode the RG 4892 payload (13 fields)");
    const q = qr!;
    log(`  ver=${q.ver} fecha=${q.fecha} cuit=${q.cuit} ptoVta=${q.ptoVta} tipoCmp=${q.tipoCmp}`);
    log(`  nroCmp=${q.nroCmp} importe=${q.importe} moneda=${q.moneda} ctz=${q.ctz}`);
    log(`  tipoDocRec=${q.tipoDocRec} nroDocRec=${q.nroDocRec} tipoCodAut=${q.tipoCodAut} codAut=${q.codAut}`);
    if (options.debug) {
      log(`  [debug] raw payload: ${JSON.stringify(q)}`);
    }

    // ── Closing summary ────────────────────────────────────────────────────
    const counts = {
      emitted: emitted.length,
      blocked: 1, // lowConfidence
      flagged: 1, // no CUIT
      discarded: 1, // non-sale transfer
    };
    step("13", "Closing summary");
    log(`  Emitted:   ${counts.emitted} (CAEs printed above)`);
    log(`  Blocked:   ${counts.blocked} (low-confidence OCR — needs correction)`);
    log(`  Flagged:   ${counts.flagged} (no CUIT — needs registry resolution)`);
    log(`  Discarded: ${counts.discarded} (non-sale transfer)`);
    log(`  Files:     ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);

    return {
      emitted,
      blockedRefused,
      blockedRefusalReason,
      flaggedReason,
      discardedReason: discarded.discardReason,
      qr: q,
      files,
      counts,
    };
  } finally {
    await close();
  }
}
