"use client";

import React, { useEffect, useState } from "react";
import type { PointOfSaleClient, PointsOfSaleReport } from "@/lib/clients/points-of-sale";
import { createPointsOfSaleWorkflow, initialPointsOfSaleState } from "./points-of-sale-workflow";

export function PointsOfSaleResult({ report }: { report: PointsOfSaleReport }) {
  const configured = {
    available_cae: "aparece disponible para CAE en esta consulta de homologación.",
    not_returned: "no aparece en los puntos devueltos por ARCA. No está verificado.",
    not_available_cae: "no está disponible para CAE según esta consulta (revise tipo, bloqueo o baja).",
    unverified: "no pudo verificarse: ARCA devolvió datos de estado desconocidos o incompletos.",
  }[report.configuredPoint];
  return <div role="status">
    <p>CUIT consultado: {report.client.cuit}. Punto configurado {report.client.ptoVta}: {configured}</p>
    <p>Consulta de homologación: {report.checkedAt}. El resultado no se actualiza automáticamente.</p>
    {report.points.length === 0 ? <p>ARCA no devolvió puntos de venta para este CUIT.</p> : <ul>
      {report.points.map(point => <li key={point.number}>
        Punto {point.number} · {point.emissionType === "unknown" ? "Tipo sin verificar" : point.emissionType}
        {" · "}{({ available: "Disponible", blocked: "Bloqueado", deregistered: "Dado de baja", unknown: "Sin verificar" })[point.status]}
        {` · Bloqueado: ${point.blocked === true ? "S" : point.blocked === false ? "N" : "sin verificar"}`}
        {` · Baja: ${point.deregisteredOn ?? "sin fecha verificada"}`}
      </li>)}
    </ul>}
  </div>;
}

export default function PointsOfSaleAction({ client, fingerprint, enabled, editing }: {
  client: PointOfSaleClient; fingerprint: string | null; enabled: boolean; editing: boolean;
}) {
  const [state, setState] = useState(initialPointsOfSaleState);
  const [workflow] = useState(() => createPointsOfSaleWorkflow(client, fingerprint ?? "", setState, (...args) => fetch(...args)));
  useEffect(() => () => workflow.dispose(), [workflow]);
  return <div className="points-of-sale-action">
    <button type="button" disabled={!enabled || !fingerprint || editing || state.checking} onClick={() => void workflow.check()}>
      {state.checking ? "Consultando puntos de venta…" : "Consultar puntos de venta en homologación"}
    </button>
    {!enabled ? <p>Disponible solo con ARCA_ENV=homologacion.</p> : !fingerprint ? <p>Guarde un certificado válido en Credenciales y actualice la página.</p> : null}
    <p className="helper-note">Solo consulta: no emite comprobantes y no crea ni modifica puntos de venta ni datos del cliente. Verificar el punto de venta no confirma la habilitación fiscal completa para facturar.</p>
    {state.error ? <p role="alert">{state.error}</p> : null}
    {state.report ? <PointsOfSaleResult report={state.report} /> : null}
  </div>;
}
