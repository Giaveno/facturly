import { describe, it, expect } from "vitest";
import {
  ArcaGatewayFake,
  CAE_BASE,
  CAE_VALIDITY_DAYS,
} from "./arca-gateway.fake";
import type { FECAEReq } from "@/ports/arca-gateway";

const req: FECAEReq = {
  cuit: "20123456786",
  ptoVta: 1,
  cbteTipo: 1,
  cbteNro: 7,
  receptorDocTipo: 80,
  receptorDocNro: 30710145764,
  receptorRazonSocial: "EMPRESA EJEMPLO S.A.",
  fechaEmision: "2026-09-22",
  fechaVto: "2026-10-22",
  moneda: "PES",
  cotizacion: 1,
  importeNeto: 100000,
  importeIva: 21000,
  importeTotal: 121000,
};

describe("arca-gateway.fake — deterministic, offline", () => {
  it("resolves a seeded CUIT to its IVA condition", async () => {
    const fake = new ArcaGatewayFake();
    expect(await fake.getIvaCondition("20123456786", "20123456786")).toBe("ri");
    expect(await fake.getIvaCondition("20123456786", "30710145764")).toBe(
      "monotributista",
    );
  });

  it("returns 'unresolved' for an unknown CUIT", async () => {
    const fake = new ArcaGatewayFake();
    expect(await fake.getIvaCondition("20123456786", "99999999999")).toBe(
      "unresolved",
    );
  });

  it("issues invoices with sequential numbers and exact 14-digit CAEs", async () => {
    const fake = new ArcaGatewayFake();
    const first = await fake.issueInvoice(req);
    const second = await fake.issueInvoice(req);

    expect(first.cbteNro).toBe(1);
    expect(second.cbteNro).toBe(2);
    // Deterministic CAE: CAE_BASE + cbteNro, zero-padded to 14 digits.
    expect(first.cae).toBe(String(CAE_BASE + 1).padStart(14, "0"));
    expect(second.cae).toBe(String(CAE_BASE + 2).padStart(14, "0"));
    expect(first.cae).not.toBe(second.cae);
  });

  it("derives an EXACT due date from an injected clock (10-day validity)", async () => {
    const fixed = new Date("2026-09-22T00:00:00.000Z");
    const fake = new ArcaGatewayFake(undefined, 1, () => fixed);
    const result = await fake.issueInvoice(req);

    // 2026-09-22 + CAE_VALIDITY_DAYS (10) = 2026-10-02.
    expect(result.caeFchVto).toBe("2026-10-02");
    // The injected clock object must not be mutated by the fake.
    expect(fixed.toISOString().slice(0, 10)).toBe("2026-09-22");
    expect(CAE_VALIDITY_DAYS).toBe(10);
  });

  it("does not require network or keys (pure in-memory)", async () => {
    const fake = new ArcaGatewayFake(new Map([["20123456786", "ri"]]));
    const result = await fake.issueInvoice(req);
    expect(result.cbteNro).toBe(1);
  });
});
