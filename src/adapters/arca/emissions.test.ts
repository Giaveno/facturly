import { describe, it, expect } from "vitest";
import { readEmissionsEnabled } from "./emissions";

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
});
