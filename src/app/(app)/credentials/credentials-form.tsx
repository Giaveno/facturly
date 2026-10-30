"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CertificateInfo } from "@/lib/credentials/pem";
import { createCredentialsWorkflow, initialCredentialsState } from "./credentials-workflow";

const STATUS_LABELS = { ok: "Autenticación verificada", failure: "No se pudo autenticar", timeout: "Tiempo de espera agotado", not_configured: "Credenciales no configuradas o no disponibles" };

export default function CredentialsForm({ initialCertificate = null }: { initialCertificate?: CertificateInfo | null }) {
  const router = useRouter();
  const [state, setState] = useState(() => initialCredentialsState(initialCertificate));
  const workflow = useRef<ReturnType<typeof createCredentialsWorkflow> | null>(null);
  if (!workflow.current) workflow.current = createCredentialsWorkflow(initialCertificate, setState, { request: (...args) => fetch(...args), saved: () => router.refresh() });
  const flow = workflow.current;
  useEffect(() => { flow.updateCertificate(initialCertificate); }, [flow, initialCertificate]);
  useEffect(() => () => flow.dispose(), [flow]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void flow.save({ certPem: String(data.get("certPem") ?? ""), keyPem: String(data.get("keyPem") ?? "") }, () => form.reset());
  }

  return (
    <div className="surface form-stack credential-summary credential-editor">
      <form className="form-stack credential-pem-form" onSubmit={onSubmit}>
        <label>Certificado público (PEM)<textarea name="certPem" rows={6} required /></label>
        <label>Clave privada (PEM)<textarea name="keyPem" rows={8} required autoComplete="off" /></label>
        <button type="submit" disabled={state.saving}>{state.saving ? "Guardando…" : "Guardar credenciales"}</button>
        {state.savedMessage ? <p role="status">{state.savedMessage}</p> : null}
        {state.saveError ? <p role="alert">{state.saveError}</p> : null}
      </form>
      <section className="form-stack" aria-labelledby="connection-check-heading">
        <h3 id="connection-check-heading">Autenticación en homologación</h3>
        <p className="helper-note">Esta prueba solo verifica la autenticación WSAA para WSFE y Padrón A5; no emite comprobantes. El punto de venta, el emisor y las validaciones fiscales se comprueban por separado.</p>
        <button className="button secondary" type="button" disabled={state.saving || state.checking || !state.certificate} onClick={() => void flow.check()}>
          {state.checking ? "Probando conexión…" : "Probar conexión en homologación"}
        </button>
        <div aria-live="polite" aria-busy={state.checking}>
          {state.checking ? <p role="status">Verificando autenticación en homologación…</p> : null}
          {state.report ? <>
            <p>Entorno comprobado: homologación. Certificado: {state.report.certificate?.subjectCn}; huella SHA-256: {state.report.certificate?.fingerprint}.</p>
            <ul>{state.report.services.map(result => <li key={result.service}>{result.service}: {STATUS_LABELS[result.status]}</li>)}</ul>
          </> : null}
          {state.checkError ? <p role="alert">{state.checkError}</p> : null}
        </div>
      </section>
    </div>
  );
}
