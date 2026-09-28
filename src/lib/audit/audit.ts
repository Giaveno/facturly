/**
 * Audit trail — the single writer for `audit_log`.
 *
 * Every fiscal action (approval, rejection, emission attempt, CAE persisted,
 * emission error, flagged-for-review) is recorded here. The payload must never
 * contain token/sign/private-key material — only invoice/row identifiers,
 * CUITs, comprobante numbers, ARCA codes/messages, and CAEs (a CAE is public,
 * printed on the invoice).
 */

import { auditLog } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export interface AuditEntry {
  /** Who/What performed the action ("system" for automated paths). */
  actor: string;
  /** Stable action id, e.g. "invoice.approved", "emission.cae_persisted". */
  action: string;
  invoiceId?: string | null;
  rowId?: string | null;
  payload?: Record<string, unknown>;
}

/** Writes one audit row. Never throws secret material. */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    invoiceId: entry.invoiceId ?? null,
    rowId: entry.rowId ?? null,
    payload: entry.payload,
  });
}
