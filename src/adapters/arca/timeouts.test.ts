import { expect, it } from "vitest";
import { arcaTimeouts, HOMOLOGACION_QUERY_MS } from "./timeouts";
it("extends homologacion only and budgets sequential TA + WSFE with UI headroom", () => {
 expect(arcaTimeouts("homologacion")).toEqual({callMs:25000,acquisitionMs:30000});
 expect(arcaTimeouts("production")).toEqual({callMs:20000,acquisitionMs:8000});
 expect(HOMOLOGACION_QUERY_MS).toBeGreaterThan(30000 + 25000);
});
