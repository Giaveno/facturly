/** Explicitly scoped read-only homologation query. Never issues or changes status. */
import { existsSync, writeFileSync } from "node:fs";
async function main() {
  process.loadEnvFile(".env");
  if (process.env.ARCA_ENV !== "homologacion") throw new Error("Homologacion required");
  const marker = ".data/reserva-11-consulta.started.json";
  if (existsSync(marker)) throw new Error("Query already started; refusing retry");
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("../src/lib/db/schema");
  const { DrizzleCredentialsRepository } = await import("../src/lib/db/credentials-repository");
  const { DrizzleTaCacheStore } = await import("../src/lib/db/ta-cache-store");
  const { createCredentialTaCache } = await import("../src/adapters/arca/credential-ta-cache");
  const { WSAA_HOMOLOGACION_URL, WSFE_HOMOLOGACION_URL } = await import("../src/adapters/arca/constants");
  const { WsfeClient } = await import("../src/adapters/arca/wsfe");
  const { XMLParser } = await import("fast-xml-parser");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: "-c default_transaction_read_only=on" });
  let calls = 0;
  try {
    const rows = await pool.query("select id,cbte_tipo from issued_invoices where cuit='20436027525' and pto_vta=1 and cbte_nro=1 and cae is null");
    if (rows.rows.length !== 1 || rows.rows[0].cbte_tipo !== 11) throw new Error("Expected single legacy reservation11/PV1/1");
    const db = drizzle(pool, { schema });
    const credentials = await new DrizzleCredentialsRepository(db).get();
    if (!credentials) throw new Error("Credentials unavailable");
    const store = new DrizzleTaCacheStore(db);
    const cache = createCredentialTaCache({ url: WSAA_HOMOLOGACION_URL, credentials: { certPem: credentials.certPem, keyPem: "" },
      store: { async get(key) { const t = await store.get(key); if (!t || t.expiresAt < Date.now() + 300000) throw new Error("Valid cached ticket required; no WSAA allowed"); return t; }, async put() { throw new Error("Cache writes prohibited"); } },
      transport: { async post() { throw new Error("WSAA prohibited"); } } });
    const ticket = await cache.get("wsfe");
    writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString(), type: 11, number: 1 }), { flag: "wx" });
    const client = new WsfeClient({ url: WSFE_HOMOLOGACION_URL, transport: { async post(url, body, headers) {
      if (calls !== 0 || url !== WSFE_HOMOLOGACION_URL || !body.includes("FECompConsultar") || body.includes("FECAESolicitar")) throw new Error("Readonly one-shot guard");
      calls++;
      const response = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(25000) });
      const xml = await response.text();
      const parsed = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(xml);
      const result = parsed.Envelope?.Body?.FECompConsultarResponse?.FECompConsultarResult;
      const err = result?.Errors?.Err;
      console.log(JSON.stringify({ httpStatus: response.status, tuple: { cuit: "20436027525", ptoVta: 1, cbteTipo: 11, cbteNro: 1 }, errors: err ? (Array.isArray(err) ? err : [err]).map((e: { Code: string; Msg: string }) => ({ code: e.Code, message: e.Msg })) : [] }));
      return xml;
    } } });
    try {
      const result = await client.consultarComprobante({ token: ticket.token, sign: ticket.sign, cuit: "20436027525" }, { ptoVta: 1, cbteTipo: 11, cbteNro: 1 });
      console.log(JSON.stringify({ result }));
    } catch (error) {
      const e = error as Error & { diagnostic?: unknown };
      console.log(JSON.stringify({ name: e.name, message: e.message, diagnostic: e.diagnostic }));
    }
  } finally { console.log(JSON.stringify({ calls: { wsaa: 0, consultar: calls, emitir: 0 }, databaseWrites: 0 })); await pool.end(); }
}
main().catch((error: Error) => { console.error(JSON.stringify({ name: error.name, message: error.message })); process.exitCode = 1; });
