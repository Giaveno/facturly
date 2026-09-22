/**
 * Payer registry — global, self-learning.
 *
 * Matching is EXACT on CBU/CVU/alias/name (fuzzy matching is OUT of v1). Every
 * manual correction teaches the registry by upserting the payer's CUIT.
 *
 * Matching fetches ALL candidate rows and throws on ambiguity instead of
 * silently picking one — SQL row order is undefined, so a "first hit" can write
 * a learned CUIT onto the wrong payer (reproduced in the fix pass).
 */

import { eq, or } from "drizzle-orm";
import { payers } from "./schema";
import type { Db } from "./types";

type PayerRow = typeof payers.$inferSelect;

/**
 * Thrown when a correction matches more than one DISTINCT payer (e.g. the CBU
 * belongs to one payer and the alias to another, or two payers share a name).
 * The registry refuses to guess rather than corrupt the wrong row.
 */
export class PayerAmbiguityError extends Error {
  readonly payerIds: string[];

  constructor(payerIds: string[]) {
    super(
      `Ambiguous payer match: ${payerIds.length} distinct payers (${payerIds.join(
        ", ",
      )})`,
    );
    this.name = "PayerAmbiguityError";
    this.payerIds = payerIds;
  }
}

/**
 * Normalizes a payer legal name for registry matching:
 *   - uppercase, trim, collapse internal whitespace
 *   - strip accents (Unicode NFD + remove combining marks)
 *   - drop legal-form suffixes: S.A., S.A, SA, S.R.L., S.R.L, SRL
 *
 * Throws when the input is empty/whitespace or consists ONLY of a legal-form
 * suffix (which would otherwise pass through to the NOT NULL `name` column as a
 * meaningless value).
 */
export function normalizePayerName(input: string): string {
  const upper = input.toUpperCase();
  const withoutAccents = upper.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const collapsed = withoutAccents.replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    throw new Error("normalizePayerName: name is empty");
  }
  // `(?:^|\s)` lets a name that IS only a suffix match (rejected below), while
  // requiring whitespace before a suffix in a longer name so "LA CASA" (ends in
  // "SA") is never clipped.
  const suffix = /(?:^|\s)(S\.?\s?A\.?|S\.?\s?R\.?\s?L\.?|SRL)$/;
  const stripped = collapsed.replace(suffix, "").trim();
  if (stripped === "") {
    throw new Error(
      `normalizePayerName: name is only a legal-form suffix ("${input}")`,
    );
  }
  return stripped;
}

export interface UpsertPayerInput {
  name: string;
  cbu?: string;
  cvu?: string;
  alias?: string;
  cuit?: string;
}

export interface UpsertPayerResult {
  id: string;
  learnedFrom: string;
  inserted: boolean;
}

interface PayerKeys {
  cbu?: string;
  cvu?: string;
  alias?: string;
  name?: string;
}

/** Fetches ALL rows matching any provided key (no ORDER BY, no LIMIT). */
async function findExistingPayers(
  db: Db,
  keys: PayerKeys,
): Promise<PayerRow[]> {
  const conditions = [];
  if (keys.cbu) conditions.push(eq(payers.cbu, keys.cbu));
  if (keys.cvu) conditions.push(eq(payers.cvu, keys.cvu));
  if (keys.alias) conditions.push(eq(payers.alias, keys.alias));
  if (keys.name) conditions.push(eq(payers.name, keys.name));
  if (conditions.length === 0) return [];
  return db.select().from(payers).where(or(...conditions));
}

/**
 * Resolves the match set to at most one payer. When the matches contain more
 * than one DISTINCT payer id, throws — ambiguity must never silently corrupt.
 */
function resolveSingleMatch(
  rows: PayerRow[],
): PayerRow | undefined {
  const distinctIds = new Set(rows.map((r) => r.id));
  if (distinctIds.size > 1) {
    throw new PayerAmbiguityError([...distinctIds]);
  }
  return rows[0];
}

/** Learns a corrected CUIT onto a matched payer, when present and different. */
async function learnCuit(
  db: Db,
  row: PayerRow,
  cuit?: string,
): Promise<void> {
  if (cuit && cuit !== row.cuit) {
    await db.update(payers).set({ cuit }).where(eq(payers.id, row.id));
  }
}

/**
 * Upserts a payer into the global registry:
 *   - match by CBU/CVU/alias/name (exact) → update the stored CUIT (learn)
 *   - ambiguous match (multiple distinct payers) → throw
 *   - no match → insert with `learnedFrom = 'manual'`
 *
 * The insert uses `onConflictDoNothing` + a re-select so two concurrent upserts
 * of the same new unique key are idempotent instead of throwing an unhandled
 * unique-violation.
 */
export async function upsertPayer(
  db: Db,
  input: UpsertPayerInput,
): Promise<UpsertPayerResult> {
  const name = normalizePayerName(input.name);
  const keys: PayerKeys = {
    cbu: input.cbu,
    cvu: input.cvu,
    alias: input.alias,
    name,
  };

  const existing = resolveSingleMatch(await findExistingPayers(db, keys));
  if (existing) {
    await learnCuit(db, existing, input.cuit);
    return { id: existing.id, learnedFrom: existing.learnedFrom, inserted: false };
  }

  const insertedRows = await db
    .insert(payers)
    .values({
      name,
      cbu: input.cbu ?? null,
      cvu: input.cvu ?? null,
      alias: input.alias ?? null,
      cuit: input.cuit ?? null,
      learnedFrom: "manual",
    })
    .onConflictDoNothing()
    .returning();

  const inserted = insertedRows[0];
  if (inserted) {
    return { id: inserted.id, learnedFrom: inserted.learnedFrom, inserted: true };
  }

  // A concurrent insert of the same unique key won the race — re-select it and
  // apply the learned CUIT so the correction is never lost.
  const winner = resolveSingleMatch(await findExistingPayers(db, keys));
  if (!winner) {
    throw new Error(
      "upsertPayer: insert conflicted but no matching payer found on re-select",
    );
  }
  await learnCuit(db, winner, input.cuit);
  return { id: winner.id, learnedFrom: winner.learnedFrom, inserted: false };
}
