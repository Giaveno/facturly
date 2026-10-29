import { getDb } from "@/lib/db/client";
import { getCredentialInfo } from "@/lib/credentials/service";
import CredentialsForm from "./credentials-form";

export const dynamic = "force-dynamic";

/**
 * ARCA credentials page — the "plug in ARCA" step. Shows the currently loaded
 * certificate's PUBLIC metadata (subject, CUIT, expiry) and a form to upload
 * (or replace) the certificate + private key. The private key is encrypted at
 * rest and is NEVER shown here.
 */
export default async function CredentialsPage() {
  const info = await getCredentialInfo(getDb());

  return (
    <main className="page-content">
      <div className="page-heading"><div><p className="eyebrow">Configuración</p><h1>Credenciales ARCA</h1><p className="lede">Administrá el certificado público y la clave privada usados por el servicio.</p></div></div>

      <section className="surface credential-summary"><h2>Certificado cargado</h2>
      {info ? (
        <dl>
          <dt>Subject</dt>
          <dd>{info.subjectCn}</dd>
          <dt>CUIT</dt>
          <dd>{info.cuit ?? "not found in certificate"}</dd>
          <dt>Valid from</dt>
          <dd>{info.notBefore}</dd>
          <dt>Expires</dt>
          <dd>{info.notAfter}</dd>
          <dt>Huella SHA-256</dt>
          <dd>{info.fingerprint}</dd>
        </dl>
      ) : (
        <div className="empty-state"><strong>No hay un certificado cargado.</strong><p>Subí el certificado y su clave privada para continuar con la configuración.</p></div>
      )}
      <p className="helper-note">Los datos mostrados corresponden al certificado público. La clave privada nunca se vuelve a mostrar.</p></section>

      <section className="page-section"><h2>{info ? "Reemplazar certificado y clave" : "Cargar certificado y clave"}</h2>
      <p className="helper-note">Entorno configurado: {process.env.ARCA_ENV === "homologacion" ? "homologación" : process.env.ARCA_ENV === "production" ? "producción (prueba deshabilitada)" : "no válido (prueba deshabilitada)"}.</p>
      <CredentialsForm initialCertificate={info} />
      </section>
    </main>
  );
}
