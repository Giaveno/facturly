import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReservedAttempts } from "./reserved-attempts";
describe("reserved attempt UI fiscal isolation", () => {
    it("labels a closed historical no-record result with its consultation date", () => {
        const html = renderToStaticMarkup(createElement(ReservedAttempts, { enabled: true, rows: [{
            invoiceId: "old", status: "EMIT_FAILED", cuit: "20436027525", ptoVta: 1, cbteTipo: 11, cbteNro: 1,
            importeTotalCentavos: 100000, canConsult: false, closedNoRecordAt: "2026-10-29T23:14:55.770Z",
        }] }));
        expect(html).toContain("Verificada: no existía en ARCA en esa consulta");
        expect(html).toContain("29/10/2026");
        expect(html).toContain("sin registros en ese momento");
        expect(html).not.toContain("<button");
    });
    it("offers only consultation, keeps stale guards, never creates a PDF or changes fiscal state", () => {
        const source = readFileSync(new URL("./reserved-attempts.tsx", import.meta.url), "utf8");
        expect(source).toContain("Consultar estado en ARCA (homologación)");
        expect(source).toContain("/consult");
        expect(source).toContain("AbortController");
        expect(source).toContain("inFlight.current");
        expect(source).toContain("serie bloqueada, pendiente de conciliación");
        expect(source).toContain("identity");
        expect(source).toMatch(/15_?000/);
        expect(source).not.toMatch(/\/approve|\/pdf|recoverStuckEmissions|router.refresh|FECAESolicitar/);
    });
});
