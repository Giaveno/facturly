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
