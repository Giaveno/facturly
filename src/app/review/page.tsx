import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listReviewRows } from "@/lib/review/read-model";
import { formatCentavos } from "@/domain/money";

/**
 * Review page (skeleton). Lists OCR rows joined to their client. A BLOCKED row
 * is visibly marked and its approve action is disabled (unapprovable) — but the
 * disabled button is a HINT only. The real "a BLOCKED row can never emit"
 * guarantee is enforced server-side by `@/domain/emission`.
 */
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const rows = await listReviewRows(getDb());

  return (
    <main>
      <h1>Review</h1>
      {rows.length === 0 ? (
        <p>No rows yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Payer</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rowId} data-blocked={r.blocked || undefined}>
                <td>{r.razonSocial}</td>
                <td>{r.fields.name}</td>
                <td>{formatCentavos(r.fields.amount)}</td>
                <td>{r.status}</td>
                <td>
                  {r.blocked ? (
                    <button disabled title="Correct the fields first">
                      Blocked — cannot approve
                    </button>
                  ) : (
                    // Approve/emission is deferred to slice 4; the button is
                    // intentionally disabled until the emission pipeline lands.
                    <button disabled title="Approve/emit lands in slice 4">
                      Approve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link href="/">← Upload</Link>
      </p>
    </main>
  );
}
