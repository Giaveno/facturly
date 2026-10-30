import { describe, expect, it } from "vitest";
import { emitInvoice, NumberAllocator } from "./emission-service";
import type { Db } from "@/lib/db/types";
import type { ArcaGateway } from "@/ports/arca-gateway";
import { readFileSync } from "node:fs";

describe("retired legacy fiscal dispatch", () => {
  it("keeps diagnostic scripts and sessions unable to send or reserve legacy numbers", () => {
    const spike = readFileSync("scripts/homologacion-spike.ts", "utf8");
    const session = readFileSync("src/lib/homologacion/live-session.ts", "utf8");
    for (const source of [spike, session]) {
      expect(source).not.toContain("wsfe.solicitar(");
      expect(source).not.toContain("insert(issuedInvoices)");
      expect(source).toContain("Diagnostic issuance retired");
    }
  });
  it("cannot reserve or send even when explicitly enabled", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("database accessed"); } });
    const gateway = new Proxy({} as ArcaGateway, { get() { throw new Error("gateway accessed"); } });
    await expect(emitInvoice({ db, gateway, emissionsEnabled: true }, new NumberAllocator(gateway), "old-invoice")).rejects.toThrow("emitComprobante");
  });
});
