import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "./run-demo";

/**
 * Demo smoke test — runs the demo's core sequence in-process (temp output dir,
 * silent logger) and asserts the KEY outcomes, so CI proves the demo works even
 * if no human ever runs `pnpm demo`:
 *   - an emitted CAE exists
 *   - the blocked row was refused
 *   - the QR payload decodes to a valid 13-field RG 4892 payload
 *   - the Excel + PDF are produced on disk
 */
describe("demo smoke test — offline end-to-end", () => {
  const out = mkdtempSync(join(tmpdir(), "facturas-demo-"));

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it(
    "runs the full flow and produces the key outcomes",
    async () => {
      const result = await runDemo({ outputDir: out, log: () => {} });

      // 1. An emitted CAE exists (two Factura A invoices, 14-digit CAEs).
      expect(result.emitted).toHaveLength(2);
      for (const e of result.emitted) {
        expect(e.cae).toHaveLength(14);
        expect(e.cbteTipo).toBe(1); // Factura A (RI → Monotributista)
        expect(e.includesLegend).toBe(true); // Ley 27.618 legend visible
      }

      // 2. The blocked (low-confidence) row was refused by the emission guard.
      expect(result.blockedRefused).toBe(true);
      expect(result.blockedRefusalReason).toContain("aprobadas");

      // 3. The no-CUIT row was flagged and NOT approvable.
      expect(result.flaggedReason).toContain("CUIT");

      // 4. The non-sale transfer was discarded with a reason.
      expect(result.discardedReason).toContain("not a sale");

      // 5. The QR payload decodes to a valid RG 4892 payload (exactly 13 fields).
      expect(result.qr.tipoCodAut).toBe("E");
      expect(result.qr.codAut).toBe(Number(result.emitted[0]!.cae));
      expect(Object.keys(result.qr)).toHaveLength(13);
      expect(result.qr.importe).toBeGreaterThan(0);

      // 6. The Excel + PDF(s) were produced on disk.
      const pdfs = result.files.filter((f) => f.endsWith(".pdf"));
      const xlsx = result.files.filter((f) => f.endsWith(".xlsx"));
      expect(pdfs.length).toBeGreaterThan(0);
      expect(xlsx).toHaveLength(1);
      for (const f of result.files) {
        expect(existsSync(f)).toBe(true);
      }

      // 7. Closing counts add up.
      expect(result.counts).toEqual({
        emitted: 2,
        blocked: 1,
        flagged: 1,
        discarded: 1,
      });
    },
    60_000,
  );
});
