import { getDb } from "@/lib/db/client";
import { listClients } from "@/lib/clients/clients";
import { getCredentialInfo } from "@/lib/credentials/service";
import ClientsForm from "./clients-form";
import ClientActions from "./client-actions";

export const dynamic = "force-dynamic";

/**
 * Clients page — lists the accountant's client companies (razón social, CUIT,
 * punto de venta, condición IVA) and whether their `wsfe` delegation is enabled,
 * with controls to create/edit a client and toggle its delegation. Plain — no
 * design work.
 */
export default async function ClientsPage() {
  const db = getDb();
  const clients = await listClients(db);
  const homologationEnabled = process.env.ARCA_ENV === "homologacion";
  const certificate = homologationEnabled ? await getCredentialInfo(db).catch(() => null) : null;

  return (
    <main className="page-content">
      <div className="page-heading"><div><p className="eyebrow">Empresas emisoras</p><h1>Clientes</h1><p className="lede">Administrá los datos fiscales y las delegaciones de las empresas con las que trabajás.</p></div></div>
      <ClientsForm />

      <section className="page-section"><h2>Empresas registradas <span className="count-badge">{clients.length}</span></h2>
      {clients.length === 0 ? (
        <div className="empty-state"><strong>Todavía no hay clientes registrados.</strong><p>Creá una empresa emisora para poder cargar comprobantes.</p></div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Razón social</th>
              <th>CUIT</th>
              <th>Pto. Vta.</th>
              <th>Condición IVA</th>
              <th>Delegación wsfe</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.razonSocial}</td>
                <td>{c.cuit}</td>
                <td>{c.ptoVta}</td>
                <td>{c.condicionIva}</td>
                <td><span className={`status-pill ${c.delegationEnabled ? "status-ready" : "status-muted"}`}>{c.delegationEnabled ? "Activa" : "No configurada"}</span></td>
                <td>
                  <ClientActions
                    clientId={c.id}
                    razonSocial={c.razonSocial}
                    cuit={c.cuit}
                    ptoVta={c.ptoVta}
                    condicionIva={c.condicionIva}
                    delegationEnabled={c.delegationEnabled}
                    fingerprint={certificate?.fingerprint ?? null}
                    homologationEnabled={homologationEnabled}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="helper-note">La delegación local registra tu configuración, pero no otorga permisos en ARCA. La autorización debe gestionarse por separado en ARCA.</p>
      </section>
    </main>
  );
}
