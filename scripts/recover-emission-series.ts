/** Explicit recovery only. Consults pinned reservations and never issues a number. */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/lib/db/schema";
import { buildArcaGateway } from "../src/lib/emission/gateway";
import { recoverSeriesClaim, type ComprobanteEmissionDeps } from "../src/lib/emission/comprobante-emission-service";
import { seriesKey } from "../src/lib/emission/series-claim";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
function required(args: string[], flag: string): string {
  const v = value(args, flag);
  if (!v) throw new Error(`${flag} is required`);
  return v;
}

async function main() {
  process.loadEnvFile(".env");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; no database was opened");
  const environment = required(process.argv, "--environment") as "homologacion" | "produccion" | "production";
  if (!["homologacion", "produccion", "production"].includes(environment)) throw new Error("--environment must be homologacion or produccion");
  const cuit = required(process.argv, "--cuit");
  if (!/^\d{11}$/.test(cuit)) throw new Error("--cuit must be an 11-digit CUIT");
  const ptoVta = Number(required(process.argv, "--pto-vta"));
  const cbteTipo = Number(required(process.argv, "--cbte-tipo"));
  if (!Number.isInteger(ptoVta) || ptoVta < 1 || ptoVta > 99999) throw new Error("--pto-vta is invalid");
  if (![1, 6, 11].includes(cbteTipo)) throw new Error("--cbte-tipo is invalid");
  const canonicalEnvironment = environment === "production" ? "produccion" : environment;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 30000, statement_timeout: 30000, max: 1 });
  const db = drizzle(pool, { schema });
  try {
    const deps: ComprobanteEmissionDeps = { db, gateway: buildArcaGateway(db), environment: canonicalEnvironment };
    await recoverSeriesClaim(deps, { key: seriesKey(environment, cuit, ptoVta, cbteTipo), environment: canonicalEnvironment, emisorCuit: cuit, ptoVta, cbteTipo });
    console.log(JSON.stringify({ recovered: true, series: { environment: canonicalEnvironment, cuit, ptoVta, cbteTipo } }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Recovery stopped safely");
  process.exitCode = 2;
});
