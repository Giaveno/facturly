import { getDb } from "@/lib/db/client";
import { listClients } from "@/lib/clients/clients";
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
  const clients = await listClients(getDb());

  return (
    <main>
      <h1>Clients</h1>
      <ClientsForm />

      <h2>Client companies</h2>
      {clients.length === 0 ? (
        <p>No clients yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Razón social</th>
              <th>CUIT</th>
              <th>Pto. Vta.</th>
              <th>Condición IVA</th>
              <th>Delegación wsfe</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.razonSocial}</td>
                <td>{c.cuit}</td>
                <td>{c.ptoVta}</td>
                <td>{c.condicionIva}</td>
                <td>{c.delegationEnabled ? "Enabled" : "Disabled"}</td>
                <td>
                  <ClientActions
                    clientId={c.id}
                    razonSocial={c.razonSocial}
                    cuit={c.cuit}
                    ptoVta={c.ptoVta}
                    condicionIva={c.condicionIva}
                    delegationEnabled={c.delegationEnabled}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
