"use client";

import React, { useEffect, useState } from "react";
import { HOMOLOGATION_DISCLAIMER } from "@/lib/padron/contract";
import { createLookupWorkflow, initialLookupState } from "./lookup-workflow";

export default function LookupForm({ fingerprint, enabled }: { fingerprint: string | null; enabled: boolean }) {
  const [state, setState] = useState(initialLookupState);
  const [workflow] = useState(() => createLookupWorkflow(fingerprint ?? "", setState, (...args) => fetch(...args)));
  useEffect(() => { workflow.setFingerprint(fingerprint ?? ""); }, [workflow, fingerprint]);
  useEffect(() => { workflow.activate(); return () => workflow.dispose(); }, [workflow]);
  const report = state.report;
  return <section className="surface credential-summary">
    <p role="note"><strong>{HOMOLOGATION_DISCLAIMER}</strong></p>
    <p>Esta consulta autentica con las credenciales guardadas y solicita datos de prueba al Padrón. No acredita habilitación para facturar.</p>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); if (enabled) void workflow.check(); }}>
      <label htmlFor="lookup-cuit">CUIT a consultar</label>
      <input id="lookup-cuit" name="cuit" type="text" inputMode="numeric" autoComplete="off" maxLength={32} value={state.cuit} onChange={event => workflow.setCuit(event.target.value)} placeholder="30-12345678-9" disabled={!enabled || !fingerprint} aria-describedby="lookup-help" required />
      <p id="lookup-help" className="helper-note">Se admiten espacios y guiones. Se valida el dígito verificador antes de consultar. Espere 15 segundos entre consultas de CUIT diferentes.</p>
      <button type="submit" disabled={!enabled || !fingerprint || !state.cuit || state.checking}>{state.checking ? "Consultando Padrón…" : "Consultar condición frente al IVA"}</button>
    </form>
    {!enabled ? <p>Disponible solo con ARCA_ENV=homologacion.</p> : !fingerprint ? <p>Cargue un certificado válido en Credenciales ARCA y actualice esta página.</p> : null}
    <p className="helper-note">Solo consulta: no crea clientes, pagadores ni comprobantes, no modifica inscripciones y no emite facturas.</p>
    {state.error ? <p role="alert">{state.error}</p> : null}
    {report ? <div role="status">
      <h2>Resultado de homologación</h2>
      <p>CUIT consultado: {report.cuit}. Entorno: homologación.</p>
      <p>Autenticación WSAA: correcta. Respuesta del Padrón: recibida.</p>
      {report.razonSocial ? <p>Nombre o razón social: {report.razonSocial}</p> : null}
      <p>Condición frente al IVA: <strong>{({ ri: "Responsable inscripto", monotributista: "Monotributista", exento: "Exento", "no-determinada": "No determinada" })[report.condition]}</strong>.</p>
      <p>{({ explicit_tax: "Se identificó una inscripción tributaria explícita y activa en la respuesta de prueba.", no_supported_tax: "El Padrón devolvió datos de la persona, pero no evidencia suficiente para determinar una condición soportada. La ausencia de IVA no significa exención.", ambiguous_data: "La respuesta contiene datos incompletos, desconocidos o contradictorios; no se asignó una condición fiscal.", not_found: "El Padrón de homologación informó que no existe una persona para ese CUIT. Esto no indica que el CUIT no exista en producción." })[report.reason]}</p>
      <p>Fecha de consulta: {report.checkedAt}. El resultado no se actualiza automáticamente.</p>
    </div> : null}
  </section>;
}
