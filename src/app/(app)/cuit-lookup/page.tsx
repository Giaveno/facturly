import { getDb } from "@/lib/db/client";
import { getCredentialInfo } from "@/lib/credentials/service";
import LookupForm from "./lookup-form";

export const dynamic = "force-dynamic";
export default async function CuitLookupPage() {
  const enabled = process.env.ARCA_ENV === "homologacion";
  const info = enabled ? await getCredentialInfo(getDb()) : null;
  return <main className="page-content">
    <div className="page-heading"><div><p className="eyebrow">Consulta de prueba</p><h1>Consulta de CUIT</h1><p className="lede">Consulte la condición frente al IVA devuelta por el Padrón de homologación, sin emitir comprobantes.</p></div></div>
    <LookupForm key={info?.fingerprint ?? "none"} fingerprint={info?.fingerprint ?? null} enabled={enabled} />
  </main>;
}
