/** Closes only the historical failed attempt; no ARCA call or fiscal-row deletion. */
async function main() {
  process.loadEnvFile(".env");
  if (process.env.ARCA_ENV !== "homologacion") throw new Error("Homologacion required");
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("select r.id,r.invoice_id,i.status from issued_invoices r join invoices i on i.id=r.invoice_id where r.id=$1 and r.invoice_id=$2 and r.cuit='20436027525' and r.pto_vta=1 and r.cbte_tipo=11 and r.cbte_nro=1 and r.cae is null and i.status='EMIT_FAILED' for update of r,i", ["ff1545bf-f6ae-48e7-918f-5703021b1a9b", "14c489be-4386-46ec-a230-3a3baf1a1eac"]);
    if (result.rows.length !== 1) throw new Error("Historical failed reservation changed; refusing closure");
    const existing = await client.query("select id from audit_log where invoice_id=$1 and action='reservation_closed_no_record'", [result.rows[0].invoice_id]);
    if (existing.rows.length) throw new Error("Historical closure already recorded");
    const payload = {
      reservationId: result.rows[0].id, cuit: "20436027525", ptoVta: 1, cbteTipo: 11, cbteNro: 1,
      checkedAt: "2026-10-29T23:14:55.770Z", code: "602", message: "No existen datos en nuestros registros para los parametros ingresados.",
      source: ".data/reserva-11-consulta.log", historicalOnly: true,
      laterComprobanteId: "dc734fd5-854c-4464-8664-62f38108cc4e",
      note: "The same fiscal tuple was subsequently authorized by a separate modern comprobante. This closes only the earlier failed local attempt.",
    };
    await client.query("insert into audit_log(actor,action,invoice_id,payload) values($1,$2,$3,$4)", ["operator", "reservation_closed_no_record", result.rows[0].invoice_id, JSON.stringify(payload)]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ closed: result.rows[0].id, checkedAt: payload.checkedAt, code: payload.code, fiscalRowsChanged: 0, arcaCalls: 0 }));
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch((error: Error) => { console.error(JSON.stringify({ name: error.name, message: error.message })); process.exitCode = 1; });
