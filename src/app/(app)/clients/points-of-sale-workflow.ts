import type { PointOfSaleClient, PointsOfSaleReport } from "@/lib/clients/points-of-sale";
import { safeQueryDiagnostic } from "@/adapters/arca/query-diagnostics";

const genericFailure = "No se pudieron consultar los puntos de venta en homologación. No se verificó el punto configurado.";
function failureMessage(value: unknown, status: number): string {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const local: Record<string, string> = {
    not_found: "El cliente ya no existe.",
    credentials: "No hay credenciales utilizables. Revise el certificado y la clave guardados.",
    changed: "El cliente o las credenciales cambiaron. Actualice la página antes de consultar.",
    environment: "La consulta requiere ARCA_ENV=homologacion.",
    timeout: "La consulta superó el tiempo de espera.",
    cooldown: "Espere unos segundos antes de volver a consultar.",
  };
  const diagnostic = safeQueryDiagnostic(body.diagnostic);
  const categories = {
    http: "error HTTP del servicio", network: "fallo de red", timeout: "tiempo de espera agotado",
    "soap-fault": "falla SOAP del servicio", "provider-errors": "errores informados por ARCA",
    "malformed-response": "respuesta inválida o incompleta", "response-too-large": "respuesta demasiado grande",
    cooldown: "límite temporal de consultas", internal: "fallo interno durante la consulta",
  };
  let message = typeof body.code === "string" && Object.hasOwn(local, body.code) ? local[body.code]! : genericFailure;
  if (diagnostic) {
    message += ` Etapa: ${diagnostic.stage === "wsaa" ? "WSAA (autenticación)" : "WSFE (consulta de puntos de venta)"}. Categoría: ${categories[diagnostic.category]}.`;
    if (diagnostic.httpStatus !== undefined) message += ` HTTP ${diagnostic.httpStatus}.`;
    if (diagnostic.providerCodes?.length) message += ` Códigos ARCA: ${diagnostic.providerCodes.join(", ")}.`;
  }
  message += ` API HTTP ${status}.`;
  if (typeof body.correlationId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.correlationId)) message += ` Referencia: ${body.correlationId}.`;
  return message;
}

interface State { checking: boolean; error: string; report: PointsOfSaleReport | null }
export const initialPointsOfSaleState = (): State => ({ checking: false, error: "", report: null });

/** One mounted client/certificate snapshot; edits remount and dispose this workflow. */
export function createPointsOfSaleWorkflow(client: PointOfSaleClient, fingerprint: string, changed: (state: State) => void, request: typeof fetch) {
  let state = initialPointsOfSaleState();
  let version = 0;
  let controller: AbortController | undefined;
  const update = (patch: Partial<State>) => { state = { ...state, ...patch }; changed(state); };
  return {
    state: () => state,
    async check() {
      if (state.checking) return;
      const current = ++version;
      const abort = new AbortController(); controller = abort;
      const timer = setTimeout(() => abort.abort(), 12_000);
      const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      let errorMessage = "No se pudo completar la consulta por un fallo de red. No se verificó el punto configurado.";
      update({ checking: true, error: "", report: null });
      try {
        const report = await Promise.race([(async () => {
          const response = await request(`/api/clients/${client.id}/points-of-sale`, {
            method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ fingerprint }), signal: abort.signal,
          });
          if (!response.ok) {
            let body: unknown;
            try { body = await response.json(); } catch { /* Never display an arbitrary HTTP response body. */ }
            errorMessage = failureMessage(body, response.status);
            throw new Error("query_failed");
          }
          errorMessage = "La respuesta no corresponde al cliente o certificado actual, o está incompleta. Actualice la página y vuelva a consultar.";
          const result = await response.json() as PointsOfSaleReport;
          if (result.environment !== "homologacion" || result.fingerprint !== fingerprint ||
            !result.client || Object.entries(client).some(([key, value]) => result.client[key as keyof PointOfSaleClient] !== value)) throw new Error("snapshot_changed");
          return result;
        })(), cancelled]);
        if (current === version) update({ report });
      } catch {
        if (current === version) update({ error: abort.signal.aborted ? "La consulta superó el tiempo de espera del navegador. No se verificó el punto configurado." : errorMessage });
      } finally {
        clearTimeout(timer);
        if (current === version) update({ checking: false });
      }
    },
    dispose() { version++; controller?.abort(); state = initialPointsOfSaleState(); },
  };
}
