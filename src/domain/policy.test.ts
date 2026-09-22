import { describe, it, expect } from "vitest";
import { cbteTipo, discriminatesIva, type CondicionIVA } from "./policy";

const RECEPTORES = ["ri", "monotributista", "exento", "consumidorFinal"] as const;

describe("policy — A/B/C matrix", () => {
  it("RI → Responsable Inscripto = A(1) without legend", () => {
    expect(cbteTipo("ri", "ri")).toEqual({
      cbteTipo: 1,
      requiresLey27618Legend: false,
    });
  });

  it("RI → Monotributista = A(1) WITH Ley 27.618 legend", () => {
    expect(cbteTipo("ri", "monotributista")).toEqual({
      cbteTipo: 1,
      requiresLey27618Legend: true,
    });
  });

  it("RI → CF or Exento = B(6) without legend", () => {
    expect(cbteTipo("ri", "consumidorFinal")).toEqual({
      cbteTipo: 6,
      requiresLey27618Legend: false,
    });
    expect(cbteTipo("ri", "exento")).toEqual({
      cbteTipo: 6,
      requiresLey27618Legend: false,
    });
  });

  it("Monotributista or Exento emisor → always C(11), never a legend", () => {
    for (const emisor of ["monotributista", "exento"] as const) {
      for (const receptor of RECEPTORES) {
        expect(cbteTipo(emisor, receptor)).toEqual({
          cbteTipo: 11,
          requiresLey27618Legend: false,
        });
      }
    }
  });

  it("matches the legal A/B/C table (independent transcription of RG 5003)", () => {
    // Independent oracle — a flat transcription of the law, NOT a copy of
    // policy.ts's MATRIX. If the implementation mis-transcribed the law, this
    // test breaks instead of mirroring the same error.
    //
    // Sources:
    //   - spec #920 `invoice-type-policy`: "RI→CF/Exento=B(6), RI→Monotributista=A(1),
    //     RI→RI=A(1), Monotributo/Exento→any=C(11). E(19) is OUT of scope."
    //   - Ley 27.618 (07/2021) + RG 5003: RI→Monotributista carries the legend.
    const cases: Array<
      [CondicionIVA, CondicionIVA, 1 | 6 | 11, boolean]
    > = [
      ["ri", "ri", 1, false],
      ["ri", "monotributista", 1, true],
      ["ri", "exento", 6, false],
      ["ri", "consumidorFinal", 6, false],
      ["monotributista", "ri", 11, false],
      ["monotributista", "monotributista", 11, false],
      ["monotributista", "exento", 11, false],
      ["monotributista", "consumidorFinal", 11, false],
      ["exento", "ri", 11, false],
      ["exento", "monotributista", 11, false],
      ["exento", "exento", 11, false],
      ["exento", "consumidorFinal", 11, false],
    ];

    for (const [emisor, receptor, tipo, legend] of cases) {
      expect(cbteTipo(emisor, receptor)).toEqual({
        cbteTipo: tipo,
        requiresLey27618Legend: legend,
      });
    }
  });

  it("rejects consumidor final as emisor (a CF cannot emit)", () => {
    expect(() => cbteTipo("consumidorFinal", "ri")).toThrow();
    expect(() => cbteTipo("consumidorFinal", "monotributista")).toThrow();
  });

  it("does not leak the shared matrix — mutating the result is safe", () => {
    const decision = cbteTipo("ri", "ri");
    decision.cbteTipo = 11;
    decision.requiresLey27618Legend = true;
    // The global matrix must be unaffected by caller mutation.
    expect(cbteTipo("ri", "ri")).toEqual({
      cbteTipo: 1,
      requiresLey27618Legend: false,
    });
  });

  it("throws on an unresolved receptor instead of returning undefined", () => {
    expect(() => cbteTipo("ri", "notACondicion" as CondicionIVA)).toThrow();
    expect(() =>
      cbteTipo("monotributista", "notACondicion" as CondicionIVA),
    ).toThrow();
  });

  it("IVA discrimination derives from comprobante type, not a flag", () => {
    expect(discriminatesIva(1)).toBe(true);
    expect(discriminatesIva(6)).toBe(false);
    expect(discriminatesIva(11)).toBe(false);
  });

  it("never produces export comprobante E(19)", () => {
    for (const emisor of ["ri", "monotributista", "exento"] as const) {
      for (const receptor of RECEPTORES) {
        expect(cbteTipo(emisor, receptor).cbteTipo).not.toBe(19);
      }
    }
  });
});
