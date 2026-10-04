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
    <main>
      <h1>ARCA credentials</h1>

      <h2>Loaded certificate</h2>
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
        </dl>
      ) : (
        <p>No certificate uploaded yet.</p>
      )}

      <h2>{info ? "Replace certificate + key" : "Upload certificate + key"}</h2>
      <CredentialsForm />
    </main>
  );
}
