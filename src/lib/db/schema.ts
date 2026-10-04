/**
 * Drizzle schema for facturas-arca (Neon Postgres / PGlite offline).
 *
 * Column sets follow the design. Deviations from the design's column lists are
 * called out inline: five `created_at` columns were added (batches, photos,
 * ocr_rows, invoices, issued_invoices, audit_log) for temporal ordering of the
 * review table — these are NOT part of the design's minimal column lists.
 *
 * DUAL STATUS MACHINE (documented here AND enforced by pipeline code):
 *
 *   `ocr_rows.status` owns confidence blocking. BLOCKED/CORRECTED are BRANCHES
 *   of a correction workflow, not a linear chain:
 *       PENDING ──► CONFIDENT ──► (emittable after review)
 *       PENDING ──► BLOCKED ──► CORRECTED ──► (emittable)
 *
 *   `invoices.status` owns the invoice lifecycle:
 *       PENDING → REVIEWED → APPROVED → EMITTING → EMITTED
 *       PENDING → REJECTED (with discardReason)
 *       EMITTING → EMIT_ERROR
 *
 *   Mapping (enforced by `src/domain/emission.ts`, not by the enum alone):
 *       BLOCKED   ⇒ the invoice stays PENDING (not emittable)
 *       CORRECTED ⇒ the invoice becomes REVIEWED
 */

import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { OcrFields } from "../../ports/ocr-provider";

export const ocrRowStatus = pgEnum("ocr_row_status", [
  "PENDING",
  "CONFIDENT",
  "BLOCKED",
  "CORRECTED",
  // A crashed/failed extraction must be distinct from "in progress" (PENDING)
  // so the accountant can see and act on it (W7).
  "FAILED",
]);

export const invoiceStatus = pgEnum("invoice_status", [
  "PENDING",
  "REVIEWED",
  "APPROVED",
  "EMITTING",
  "EMITTED",
  "REJECTED",
  // EMIT_ERROR: transient failure, recoverable (the reservation replays its
  // pinned cbteNro). EMIT_FAILED: a PERMANENT ARCA rejection — terminal, never
  // re-queued by the recovery sweeper (W2).
  "EMIT_ERROR",
  "EMIT_FAILED",
]);

/**
 * Condición de IVA (AFIP). A pgEnum so the DB enforces the same finite set the
 * `CondicionIVA` domain type declares (ri, monotributista, exento,
 * consumidorFinal).
 */
export const condicionIva = pgEnum("condicion_iva", [
  "ri",
  "monotributista",
  "exento",
  "consumidorFinal",
]);

/** The accountant — sole user (spec). */
export const accountant = pgTable("accountant", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

/** A client company under the accountant's management. */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cuit: text("cuit").notNull(),
    razonSocial: text("razon_social").notNull(),
    ptoVta: integer("pto_vta").notNull(),
    condicionIva: condicionIva("condicion_iva").notNull(),
  },
  (table) => [
    // A CUIT identifies exactly one client company — duplicate registration is
    // a data error, enforced at the DB.
    uniqueIndex("clients_cuit_unique").on(table.cuit),
  ],
);

/**
 * Global self-learning payer registry (accountant-wide). Unique PARTIAL indexes
 * on cbu/cvu/alias so multiple NULLs coexist while any real value is unique.
 */
export const payers = pgTable(
  "payers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cbu: text("cbu"),
    cvu: text("cvu"),
    alias: text("alias"),
    name: text("name").notNull(),
    cuit: text("cuit"),
    learnedFrom: text("learned_from").notNull().default("manual"),
  },
  (table) => [
    uniqueIndex("payers_cbu_unique")
      .on(table.cbu)
      .where(sql`${table.cbu} IS NOT NULL`),
    uniqueIndex("payers_cvu_unique")
      .on(table.cvu)
      .where(sql`${table.cvu} IS NOT NULL`),
    uniqueIndex("payers_alias_unique")
      .on(table.alias)
      .where(sql`${table.alias} IS NOT NULL`),
  ],
);

/** A group of photos uploaded for one client (no auto-attribution). */
export const batches = pgTable("batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One receipt photo within a batch. */
export const photos = pgTable("photos", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => batches.id),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** One OCR-extracted row per photo. */
export const ocrRows = pgTable("ocr_rows", {
  id: uuid("id").primaryKey().defaultRandom(),
  photoId: uuid("photo_id")
    .notNull()
    .references(() => photos.id),
  fields: jsonb("fields").$type<OcrFields>().notNull(),
  confidence: jsonb("confidence").$type<Record<string, number>>().notNull(),
  // Checksum-validated CUIT, or null when absent (registry resolution).
  cuit: text("cuit"),
  status: ocrRowStatus("status").notNull().default("PENDING"),
  // Set when a PENDING row's async OCR fails (status FAILED) — the reason the
  // extraction crashed, surfaced to the accountant (W7).
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * The invoice derived from an OCR row (materialized at review time). Receptor
 * amounts are bigint centavos; the receptor document number is bigint because a
 * CUIT is 11 digits (~2.0e10–3.5e10) and overflows a 32-bit `integer`.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ocrRowId: uuid("ocr_row_id")
      .notNull()
      .references(() => ocrRows.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    status: invoiceStatus("status").notNull().default("PENDING"),
    cbteTipo: integer("cbte_tipo"), // 1|6|11 — resolved by policy once receptor is known
    discardReason: text("discard_reason"),
    receptorDocTipo: integer("receptor_doc_tipo"),
    receptorDocNro: bigint("receptor_doc_nro", { mode: "number" }),
    // WSFEv1 `CondicionIVAReceptorId` (RG 5616): 1 RI, 4 Exento, 5 CF, 6
    // Monotributista. This is SEPARATE from `receptorDocTipo` (80 CUIT / 99 CF).
    condicionIvaReceptorId: integer("condicion_iva_receptor_id"),
    receptorRazonSocial: text("receptor_razon_social"),
    fechaEmision: date("fecha_emision"),
    fechaVto: date("fecha_vto"),
    moneda: text("moneda"),
    // numeric with mode:"number" so the port's `cotizacion: number` does not
    // require a string↔number cast at the boundary.
    cotizacion: numeric("cotizacion", { mode: "number" }),
    importeNetoCentavos: bigint("importe_neto_centavos", { mode: "number" }),
    importeIvaCentavos: bigint("importe_iva_centavos", { mode: "number" }),
    importeTotalCentavos: bigint("importe_total_centavos", { mode: "number" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // ARCA only accepts comprobante types 1 (Factura A), 6 (Factura B), and
    // 11 (Factura C). The DB rejects anything else before ARCA is contacted.
    check("invoices_cbte_tipo_check", sql`${table.cbteTipo} IN (1, 6, 11)`),
  ],
);

/**
 * Issued invoices — the idempotency guard. ARCA's canonical duplicate signal is
 * error 10015/10016 on an already-issued (cuit, ptoVta, cbteTipo, cbteNro).
 * This unique index makes a re-emit physically impossible: the DB rejects a
 * second row with the same key before ARCA is ever contacted.
 *
 * RESERVATION PATTERN (slice 4): the emission job inserts the row with the
 * intended `cbteNro` BEFORE calling ARCA, so the unique index pins the number
 * and a concurrent/duplicate attempt is rejected at the DB. At that moment the
 * CAE does not exist yet, so `cae`/`caeFchVto` are NULLABLE — a NULL CAE marks a
 * reservation that is still awaiting ARCA (or stuck in EMIT_ERROR). The CAE is
 * written onto the SAME row after `FECAESolicitar` returns. A retry replays the
 * pinned `cbteNro` (never re-derives it) so ARCA returns 10015/10016 and the
 * CAE is recovered via FECompConsultar.
 */
export const issuedInvoices = pgTable(
  "issued_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    cuit: text("cuit").notNull(),
    ptoVta: integer("pto_vta").notNull(),
    cbteTipo: integer("cbte_tipo").notNull(),
    cbteNro: bigint("cbte_nro", { mode: "number" }).notNull(),
    // Nullable: a reservation row (emission in flight or EMIT_ERROR) has no CAE
    // yet. The unique idempotency index is what prevents a duplicate emission.
    cae: text("cae"),
    caeFchVto: date("cae_fch_vto"),
    // Every other money column carries the `_centavos` suffix; this one must too.
    importeTotalCentavos: bigint("importe_total_centavos", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // ARCA's canonical duplicate signal is (cuit, ptoVta, cbteTipo, cbteNro).
    // This unique index makes a re-emit of the SAME NUMBER physically
    // impossible (the DB rejects a second row before ARCA is contacted).
    uniqueIndex("issued_invoices_idempotency").on(
      table.cuit,
      table.ptoVta,
      table.cbteTipo,
      table.cbteNro,
    ),
    // The fiscal identity of an emission is the INVOICE row, not the number.
    // One invoice can have AT MOST one reservation regardless of which number
    // the (concurrent) allocator picked — this is the real guard against a
    // second invoice for the same sale (C3).
    uniqueIndex("issued_invoices_invoice_id_unique").on(table.invoiceId),
  ],
);

/** Immutable audit trail. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  rowId: uuid("row_id").references(() => ocrRows.id),
});

/** Per-client wsfe delegation authorizations. */
export const delegations = pgTable(
  "delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    cuit: text("cuit").notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (table) => [
    // A client has AT MOST ONE delegation row. Without this, concurrent
    // enable/disable on a zero-row client (or any future stray insert) can
    // create TWO rows and the emission service's `some(enabled)` guard would be
    // satisfied by whichever arbitrary row the DB returns (W3).
    uniqueIndex("delegations_client_unique").on(table.clientId),
  ],
);

/** The single-row key for the `credentials` table (one global credential). */
export const CREDENTIALS_SCOPE = "singleton";

/** The accountant's encrypted ARCA X.509 certificate + key (AES-256-GCM). */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Constant scope column whose unique index enforces the single-row
    // invariant at the DB (a concurrent upload can never insert a second row).
    scope: text("scope").notNull().default(CREDENTIALS_SCOPE),
    certPem: text("cert_pem").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
  },
  (table) => [
    uniqueIndex("credentials_singleton_unique").on(table.scope),
  ],
);

/**
 * WSAA ticket cache — one row per ARCA service (`wsfe`, `ws_sr_constancia_inscripcion`).
 *
 * The `service` primary key makes the two TAs cache INDEPENDENTLY (design: keys
 * `ta:wsfe` and `ta:padron`). Timestamps are epoch milliseconds (bigint) so the
 * cache logic compares integers — no Date/timezone ambiguity between PGlite and
 * Neon. This DB-backed cache is required because the app runs on serverless
 * (Next.js): a process-memory cache does NOT survive across invocations.
 */
export const taCache = pgTable("ta_cache", {
  service: text("service").primaryKey(),
  token: text("token").notNull(),
  sign: text("sign").notNull(),
  expiresAtMs: bigint("expires_at_ms", { mode: "number" }).notNull(),
  issuedAtMs: bigint("issued_at_ms", { mode: "number" }).notNull(),
});
