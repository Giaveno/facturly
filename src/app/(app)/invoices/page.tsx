import Link from "next/link";
import { listReservedAttempts } from "@/lib/invoices/reconciliation";
import { ReservedAttempts } from "./reserved-attempts";
import { getDb } from "@/lib/db/client";
import { listIssuedInvoices } from "@/lib/invoices/read-model";
import { formatCentavos } from "@/domain/money";
import ComprobantesList from "./comprobantes-list";

/**
 * Invoices page — lists issued invoices (status, client, comprobante type,
 * number, CAE, amount) read from the DB, with a download-PDF link per row.
 * A NULL-CAE reservation still shows here, but its PDF link is hidden (the
 * server route enforces the "no CAE ⇒ not issued" rule regardless).
 */
export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const db = getDb();
  const rows = await listIssuedInvoices(db);
  const attempts = await listReservedAttempts(db);

  return (
    <main className="page-content">
      <div className="page-heading"><div><p className="eyebrow">Comprobantes emitidos</p><h1>Facturas</h1><p className="lede">Consultá las facturas emitidas y descargá el PDF cuando esté disponible.</p></div><span className="count-badge">{rows.length} facturas</span></div>
      {rows.length === 0 ? (
        <div className="empty-state"><strong>Todavía no hay facturas emitidas.</strong><p>Las facturas aparecerán acá una vez que se hayan emitido.</p><Link href="/review">Ir a revisión</Link></div>
      ) : (
        <div className="table-wrap"><table>
          <thead>
            <tr>
              <th>Empresa emisora</th><th>Tipo</th><th>Número</th>
              <th>CAE</th>
              <th>Importe</th><th>Estado</th><th>PDF</th>
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
                      Descargar PDF
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <ReservedAttempts rows={attempts} enabled={process.env.ARCA_ENV === "homologacion"} />
      <ComprobantesList />
    </main>
  );
}
