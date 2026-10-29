/**
 * Emission master kill switch.
 *
 * `EMISSIONS_ENABLED` is documented in `.env.example` as the master emission
 * switch but was never checked in code. This helper makes the control real: the
 * gateway refuses `issueInvoice` when emissions are disabled (default false —
 * the safe state). Slice 4 wires it into the emission job; for now the gateway
 * reads it at the emission boundary.
 */

/** Parses the `EMISSIONS_ENABLED` env var (default false — the safe state). */
export function readEmissionsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.EMISSIONS_ENABLED;
  if (v === undefined || v.trim() === "") return false;
  return v.trim().toLowerCase() === "true";
}

export const EMISSION_DISABLED_MESSAGE = "La emisión está deshabilitada en este servidor (configuración)";
export const EMISSION_HOMOLOGATION_REQUIRED_MESSAGE = EMISSION_DISABLED_MESSAGE;

export class EmissionConfigurationError extends Error {
  readonly code: "EMISSIONS_DISABLED" | "EMISSIONS_HOMOLOGATION_REQUIRED";
  readonly status = 503;
  readonly publicMessage: string;
  constructor(message: string, code: EmissionConfigurationError["code"]) {
    super(message);
    this.name = "EmissionConfigurationError";
    this.code = code;
    this.publicMessage = message;
  }
}

export class EmissionDisabledError extends EmissionConfigurationError {
  constructor() {
    super(EMISSION_DISABLED_MESSAGE, "EMISSIONS_DISABLED");
    this.name = "EmissionDisabledError";
  }
}

export function assertEmissionConfiguration(env: Record<string, string | undefined> = process.env): void {
  if (!readEmissionsEnabled(env)) throw new EmissionDisabledError();
  if (env.ARCA_ENV !== "homologacion") {
    throw new EmissionConfigurationError(EMISSION_HOMOLOGATION_REQUIRED_MESSAGE, "EMISSIONS_HOMOLOGATION_REQUIRED");
  }
}
