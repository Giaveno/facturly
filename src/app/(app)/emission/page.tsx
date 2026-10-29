import { resolveArcaEnvironment } from "@/lib/emission/environment";
import EmissionForm from "./emission-form";
import { getDb } from "@/lib/db/client";
import { listClients } from "@/lib/clients/clients";

export const dynamic = "force-dynamic";

export default async function EmissionPage() {
  const environment = resolveArcaEnvironment(process.env) === "production" ? "production" : "homologacion";
  const companies = await listClients(getDb());
  return <main className="page-content">
    <div className="page-heading"><div><p className="eyebrow">Emisión fiscal</p><h1>Nuevo comprobante</h1><p className="lede">Completá los datos y emití un comprobante en el ambiente configurado.</p></div>{environment === "homologacion" && <strong className="homologation-banner">Homologación: sin validez fiscal</strong>}</div>
    <EmissionForm environment={environment} companies={companies.map(({ id, razonSocial, cuit }) => ({ id, razonSocial, cuit }))} />
  </main>;
}
