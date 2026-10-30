import React from "react";
import { Building2, Plus } from "lucide-react";
import { getDb } from "@/lib/db/client";
import { listClients } from "@/lib/clients/clients";
import { getCredentialInfo } from "@/lib/credentials/service";
import ClientsForm from "./clients-form";
import ClientActions from "./client-actions";

export const dynamic = "force-dynamic";

const conditions: Record<string, string> = { ri: "Responsable inscripto", monotributista: "Monotributista", exento: "Exento" };

export default async function ClientsPage() {
  const db = getDb();
  const clients = await listClients(db);
  const homologationEnabled = process.env.ARCA_ENV === "homologacion";
  const certificate = homologationEnabled ? await getCredentialInfo(db).catch(() => null) : null;

  return <main className="page-content">
    <div className="page-heading"><div><p className="eyebrow">Organización</p><h1>Clientes</h1><p className="lede">Administrá los datos fiscales y las delegaciones de las empresas con las que trabajás.</p></div><span className="count-badge">{clients.length} empresas</span></div>
    <details className="surface new-client-panel" open={clients.length === 0}><summary><Plus size={17} aria-hidden="true" /><span>Registrar nueva empresa</span></summary><div className="new-client-content"><p className="helper-note">Completá los datos de la empresa emisora y su punto de venta.</p><ClientsForm /></div></details>
    <section className="page-section" aria-labelledby="registered-clients"><h2 id="registered-clients">Empresas registradas</h2>
      {clients.length === 0 ? <div className="empty-state"><strong>Todavía no hay clientes registrados.</strong><p>Creá una empresa emisora para poder cargar comprobantes.</p></div> : <div className="client-grid">{clients.map(client => <article className="surface client-card" key={client.id}>
        <div className="client-card-top"><span className="client-card-icon"><Building2 size={20} aria-hidden="true" /></span><span className={`status-pill ${client.delegationEnabled ? "status-ready" : "status-muted"}`}>{client.delegationEnabled ? "Delegación registrada" : "Sin delegación"}</span></div>
        <h3>{client.razonSocial}</h3><p className="client-cuit">CUIT {client.cuit}</p><dl className="client-fiscal-data"><div><dt>Punto de venta</dt><dd>{String(client.ptoVta).padStart(4, "0")}</dd></div><div><dt>Condición IVA</dt><dd>{conditions[client.condicionIva] ?? client.condicionIva}</dd></div></dl>
        <details className="client-management"><summary>Administrar empresa</summary><ClientActions clientId={client.id} razonSocial={client.razonSocial} cuit={client.cuit} ptoVta={client.ptoVta} condicionIva={client.condicionIva} delegationEnabled={client.delegationEnabled} fingerprint={certificate?.fingerprint ?? null} homologationEnabled={homologationEnabled} /></details>
      </article>)}</div>}
      <p className="helper-note client-delegation-note">La delegación local registra tu configuración, pero no otorga permisos en ARCA. La autorización debe gestionarse por separado en ARCA.</p>
    </section>
  </main>;
}
