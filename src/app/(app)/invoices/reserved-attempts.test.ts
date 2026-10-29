import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("reserved attempt UI fiscal isolation", () => {
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
