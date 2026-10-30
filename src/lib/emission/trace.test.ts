import { describe, it, expect, vi } from "vitest";
import { withEmissionTrace, tracePhase, phaseFailure, withPhase, traceFailure } from "./trace";
import { emissionDiagnostic } from "@/domain/emission-diagnostic";
describe("fiscal phase tracing", () => {
  it("restores a numerical lookup phase after a cache hit and correlates failure", async () => {
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withEmissionTrace("test-numeracion", async () => {
        tracePhase("last_number");
        await withPhase("wsaa", async () => { tracePhase("wsaa", { cache: "hit" }); });
        expect(emissionDiagnostic(phaseFailure("head falló")).phase).toBe("last_number");
        traceFailure("head falló");
      });
      expect(JSON.parse(logs.mock.calls[0]![0])).toMatchObject({ correlation_id: "test-numeracion", phase: "last_number", cause: "head falló" });
    } finally { logs.mockRestore(); }
  });
  it("preserves correlation, timestamps, current phase and sanitized causes", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await withEmissionTrace("invoice:test:approve", async () => {
        tracePhase("validation"); tracePhase("claim"); tracePhase("reservation", { cbteNro: 1 });
        tracePhase("wsaa", { login: "succeeded" }); tracePhase("dispatched");
        expect(emissionDiagnostic(phaseFailure("tiempo agotado"))).toEqual({ phase: "dispatched", cause: "tiempo agotado" });
        tracePhase("response"); tracePhase("final", { estado: "aprobado" });
      });
      const events = output.mock.calls.map(([line]) => JSON.parse(line));
      expect(events.map(event => event.phase)).toEqual(["validation", "claim", "reservation", "wsaa", "dispatched", "response", "final"]);
      expect(events.every(event => event.ts && event.correlation_id === "invoice:test:approve")).toBe(true);
      expect(emissionDiagnostic("error histórico")).toEqual({ cause: "error histórico" });
    } finally { output.mockRestore(); }
  });
});
