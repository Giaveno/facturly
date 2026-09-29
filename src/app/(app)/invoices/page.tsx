import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listIssuedInvoices } from "@/lib/invoices/read-model";
import { formatCentavos } from "@/domain/money";

/**
 * Invoices page — lists issued invoices (status, client, comprobante type,
 * number, CAE, amount) read from the DB, with a download-PDF link per row.
 * A NULL-CAE reservation still shows here, but its PDF link is hidden (the
 * server route enforces the "no CAE ⇒ not issued" rule regardless).
 */
export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const rows = await listIssuedInvoices(getDb());

  return (
    <main>
      <h1>Invoices</h1>
      {rows.length === 0 ? (
        <p>No issued invoices yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Type</th>
              <th>Number</th>
              <th>CAE</th>
              <th>Amount</th>
              <th>Status</th>
              <th>PDF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.invoiceId}>
                <td>{r.razonSocial}</td>
                <td>{r.cbteTipo ?? "—"}</td>
                <td>{r.cbteNro ?? "—"}</td>
                <td>{r.cae ?? "—"}</td>
                <td>
                  {r.importeTotalCentavos != null
                    ? formatCentavos(r.importeTotalCentavos)
                    : "—"}
                </td>
                <td>{r.status}</td>
                <td>
                  {r.cae ? (
                    <Link href={`/api/invoices/${r.invoiceId}/pdf`}>
                      Download PDF
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
