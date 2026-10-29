import Link from "next/link";
import UploadForm from "../upload-form";
import { getDb } from "@/lib/db/client";
import { listClients } from "@/lib/clients/clients";

export const dynamic = "force-dynamic";

export default async function Home() {
  const clients = await listClients(getDb());
  return (
    <main className="page-content">
      <div className="page-heading">
        <div><p className="eyebrow">Entrada de trabajo</p><h1>Cargar comprobantes</h1>
          <p className="lede">Subí los comprobantes para registrar sus datos y revisarlos antes de continuar.</p></div>
      </div>
      <UploadForm clients={clients.map(({ id, razonSocial, cuit }) => ({ id, razonSocial, cuit }))} />
      <p><Link href="/review">Ver comprobantes para revisar →</Link></p>
    </main>
  );
}
