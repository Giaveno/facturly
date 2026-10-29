import { describe, it, expect } from "vitest";
import { assertEmissionConfiguration, EmissionDisabledError, readEmissionsEnabled } from "./emissions";

describe("emissions — readEmissionsEnabled", () => {
  it("defaults to false (the safe state)", () => {
    expect(readEmissionsEnabled({})).toBe(false);
    expect(readEmissionsEnabled({ EMISSIONS_ENABLED: "" })).toBe(false);
  });

  it("parses true/false (case-insensitive)", () => {
    expect(readEmissionsEnabled({ EMISSIONS_ENABLED: "true" })).toBe(true);
    expect(readEmissionsEnabled({ EMISSIONS_ENABLED: "TRUE" })).toBe(true);
    expect(readEmissionsEnabled({ EMISSIONS_ENABLED: "false" })).toBe(false);
  });

  it("treats any other value as false", () => {
    expect(readEmissionsEnabled({ EMISSIONS_ENABLED: "yes" })).toBe(false);
  });

  it.each([
    [{ EMISSIONS_ENABLED: "true", ARCA_ENV: "homologacion" }, undefined],
    [{ EMISSIONS_ENABLED: "false", ARCA_ENV: "homologacion" }, EmissionDisabledError],
    [{ EMISSIONS_ENABLED: "true", ARCA_ENV: "production" }, Error],
  ])("enforces the enabled homologacion-only emission configuration", (env, errorType) => {
    if (!errorType) expect(() => assertEmissionConfiguration(env)).not.toThrow();
    else expect(() => assertEmissionConfiguration(env)).toThrow(errorType);
  });

  it("uses the exact public disabled message", () => {
    expect(() => assertEmissionConfiguration({})).toThrow("La emisión está deshabilitada en este servidor (configuración)");
  });
});
