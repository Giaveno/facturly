import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listReviewInvoices } from "@/lib/review/read-model";
import { formatCentavos } from "@/domain/money";
import ReviewActions from "./review-actions";

/**
 * Review page. Lists OCR rows joined to their client, with the materialized
 * invoice status and the accountant's actions (confirm / approve / reject /
 * resolve payer CUIT). A BLOCKED row is visibly marked and its approve action is
 * hidden — but the real "a BLOCKED row can never emit" guarantee is enforced
 * server-side by `@/domain/emission` and the approve route.
 */
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const rows = await listReviewInvoices(getDb());

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
                <td>
                  {r.status}
                  {r.invoiceStatus !== r.status ? ` / ${r.invoiceStatus}` : ""}
                </td>
                <td>
                  <ReviewActions
                    rowId={r.rowId}
                    invoiceId={r.invoiceId}
                    status={r.status}
                    invoiceStatus={r.invoiceStatus}
                    blocked={r.blocked}
                    failed={r.failed}
                    flagged={r.flagged}
                  />
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
