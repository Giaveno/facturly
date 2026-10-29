import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
it("backfills only matching recorded environment evidence and preserves unknown legacy blockers and numbers",async()=>{
 const db=new PGlite();
 try{
  const migrations=readMigrationFiles({migrationsFolder:fileURLToPath(new URL("../../../drizzle",import.meta.url))});
  for(const migration of migrations.slice(0,8))for(const sql of migration.sql)await db.exec(sql);
  await db.exec(`
   INSERT INTO clients(id,cuit,razon_social,pto_vta,condicion_iva) VALUES('00000000-0000-4000-8000-000000000001','20123456786','Offline',1,'exento');
   INSERT INTO batches(id,client_id) VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
   INSERT INTO photos(id,batch_id,storage_key) VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','offline.jpg');
   INSERT INTO ocr_rows(id,photo_id,fields,confidence,status) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000000003','{"name":"Offline","date":"2026-10-28","amount":625000}','{}','CORRECTED' FROM generate_series(10,12) n;
   INSERT INTO invoices(ocr_row_id,client_id,status,cbte_tipo,importe_total_centavos,approval_snapshot) SELECT id,'00000000-0000-4000-8000-000000000001','EMIT_FAILED',11,625000,CASE WHEN right(id::text,2)='10' THEN jsonb_build_object('environment','homologacion','issuerCuit','20123456786','ptoVta',1,'amount',625000,'rowId',id::text,'issuerCondition','exento','issuerName','Offline','recipientMode','consumer_final') ELSE NULL END FROM ocr_rows;
   INSERT INTO issued_invoices(invoice_id,cuit,pto_vta,cbte_tipo,cbte_nro,importe_total_centavos) SELECT id,'20123456786',1,11,row_number() over (ORDER BY ocr_row_id),625000 FROM invoices;
  `);
  for(const statement of migrations[8]!.sql)await db.exec(statement);
  const result=await db.query<{environment:string|null;cbte_nro:number;cae:string|null}>(`SELECT environment,cbte_nro,cae FROM issued_invoices ORDER BY cbte_nro`);
  expect(result.rows).toEqual([{environment:"homologacion",cbte_nro:1,cae:null},{environment:null,cbte_nro:2,cae:null},{environment:null,cbte_nro:3,cae:null}]);
  // Recorded fiscal status is preserved; migration never repairs/reissues anything.
  expect((await db.query<{status:string}>(`SELECT status FROM invoices`)).rows.every(r=>r.status==="EMIT_FAILED")).toBe(true);
 }finally{await db.close();}
});
