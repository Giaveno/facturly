ALTER TABLE "issued_invoices" ADD COLUMN "environment" text;
--> statement-breakpoint
-- Only self-consistent recorded approval provenance is eligible; unknown remains NULL.
UPDATE "issued_invoices" AS r SET "environment" = i.approval_snapshot->>'environment'
FROM "invoices" AS i
WHERE i.id = r.invoice_id
  AND i.approval_snapshot->>'environment' IN ('homologacion', 'production')
  AND i.approval_snapshot->>'issuerCuit' = r.cuit
  AND i.approval_snapshot->'ptoVta' = to_jsonb(r.pto_vta)
  AND i.approval_snapshot->'amount' = to_jsonb(r.importe_total_centavos)
  AND i.approval_snapshot->>'rowId' = i.ocr_row_id::text
  AND i.approval_snapshot->>'issuerCondition' IN ('ri','monotributista','exento')
  AND i.approval_snapshot->>'recipientMode' IN ('identified','consumer_final')
  AND jsonb_typeof(i.approval_snapshot->'issuerName') = 'string'
  AND i.importe_total_centavos = r.importe_total_centavos AND i.cbte_tipo = r.cbte_tipo;
--> statement-breakpoint
ALTER TABLE "issued_invoices" ADD CONSTRAINT "issued_invoices_environment_check" CHECK ("environment" IN ('homologacion', 'production'));
--> statement-breakpoint
DROP INDEX "issued_invoices_idempotency";
--> statement-breakpoint
ALTER TABLE "issued_invoices" ADD CONSTRAINT "issued_invoices_idempotency" UNIQUE NULLS NOT DISTINCT ("environment","cuit","pto_vta","cbte_tipo","cbte_nro");
--> statement-breakpoint
CREATE TABLE "emission_series_claims" (
 "series_key" text PRIMARY KEY NOT NULL,
 "owner" text,
 "lease_expires_at_ms" bigint NOT NULL,
 "uncertain" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_issuance" (
 "tuple_key" text PRIMARY KEY NOT NULL,
 "authorization_hash" text NOT NULL,
 "created_at" timestamp DEFAULT now() NOT NULL
);
