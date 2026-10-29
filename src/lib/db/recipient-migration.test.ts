import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";

describe("recipient migration (in-memory Postgres only)",()=>{
 it("preserves CUIT evidence/fiscal states, revokes legacy review, defaults future uploads to CF",async()=>{
  const db=new PGlite();
  try {
   const migrations=readMigrationFiles({migrationsFolder:fileURLToPath(new URL("../../../drizzle",import.meta.url))});
   for(const migration of migrations.slice(0,7)) for(const sql of migration.sql) await db.exec(sql);
   await db.exec(`
    INSERT INTO clients(id,cuit,razon_social,pto_vta,condicion_iva) VALUES ('00000000-0000-4000-8000-000000000001','20123456786','Offline',1,'monotributista');
    INSERT INTO batches(id,client_id) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
    INSERT INTO photos(id,batch_id,storage_key) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','offline.jpg');
    INSERT INTO ocr_rows(id,photo_id,fields,confidence,cuit,status) SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000000003','{"name":"OCR","date":"2026-10-28","amount":100}','{}',CASE WHEN n=10 THEN 'invalid-but-known' ELSE NULL END,'CONFIDENT' FROM generate_series(10,13) n;
    INSERT INTO invoices(ocr_row_id,client_id,status,receptor_doc_tipo) SELECT id,'00000000-0000-4000-8000-000000000001',CASE WHEN right(id::text,2)='13' THEN 'EMITTED'::invoice_status WHEN right(id::text,2)='12' THEN 'APPROVED'::invoice_status ELSE 'REVIEWED'::invoice_status END,CASE WHEN right(id::text,2)='13' THEN 80 ELSE NULL END FROM ocr_rows;
   `);
   for(const sql of migrations[7]!.sql) await db.exec(sql);
   const {rows}=await db.query<{recipient_mode:string;recipient_mode_source:string;status:string;cuit:string|null}>(`SELECT r.recipient_mode,r.recipient_mode_source,i.status,r.cuit FROM ocr_rows r JOIN invoices i ON i.ocr_row_id=r.id ORDER BY r.id`);
   expect(rows).toEqual([
    {recipient_mode:"identified",recipient_mode_source:"legacy_migration",status:"PENDING",cuit:"invalid-but-known"},
    {recipient_mode:"consumer_final",recipient_mode_source:"legacy_migration",status:"PENDING",cuit:null},
    {recipient_mode:"consumer_final",recipient_mode_source:"legacy_migration",status:"APPROVED",cuit:null},
    {recipient_mode:"identified",recipient_mode_source:"legacy_migration",status:"EMITTED",cuit:null},
   ]);
   const inserted=await db.query<{recipient_mode:string;recipient_mode_source:string}>(`INSERT INTO ocr_rows(photo_id,fields,confidence) VALUES ('00000000-0000-4000-8000-000000000003','{}','{}') RETURNING recipient_mode,recipient_mode_source`);
   expect(inserted.rows[0]).toEqual({recipient_mode:"consumer_final",recipient_mode_source:"upload_default"});
  } finally {await db.close();}
 });
});
