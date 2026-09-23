import { describe, it, expect } from "vitest";
import {
  evaluateEmissionResult,
  HOMOLOGACION_CRITERION,
} from "./homologacion";
import type { FecaesolicitarResult } from "./wsfe";

function result(overrides: Partial<FecaesolicitarResult>): FecaesolicitarResult {
  return {
    resultado: "A",
    cae: "70212345678901",
    caeFchVto: "20261002",
    cbteNro: 7,
    observaciones: [],
    errors: [],
    ...overrides,
  };
}

describe("homologacion — evaluateEmissionResult (gate decision)", () => {
  it("PASSES when Resultado=A with a 14-digit CAE", () => {
    const verdict = evaluateEmissionResult(result({}));
    expect(verdict.passed).toBe(true);
    expect(verdict.criterion).toBe(HOMOLOGACION_CRITERION);
    expect(verdict.detail).toContain("one-TA delegation model CONFIRMED");
  });

  it("FAILS when Resultado is not A (delegation rejected)", () => {
    const verdict = evaluateEmissionResult(
      result({
        resultado: "R",
        cae: null,
        errors: [{ code: "10049", msg: "Rechazado" }],
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain("Resultado=R");
    expect(verdict.detail).toContain("errors=[10049]");
    // ARCA code AND message are surfaced (not just the code).
    expect(verdict.detail).toContain("Rechazado");
    expect(verdict.detail).toContain("per-client WSAA TA model");
  });

  it("FAILS when Resultado=A but no CAE was issued (malformed)", () => {
    const verdict = evaluateEmissionResult(result({ resultado: "A", cae: null }));
    expect(verdict.passed).toBe(false);
  });

  it("FAILS on the duplicate signal (10015) — a retry, not a fresh authorization", () => {
    const verdict = evaluateEmissionResult(
      result({
        resultado: "R",
        cae: null,
        errors: [{ code: "10015", msg: "ya autorizado" }],
      }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain("10015");
  });
});
