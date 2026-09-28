ALTER TYPE "public"."invoice_status" ADD VALUE 'EMIT_FAILED';--> statement-breakpoint
ALTER TYPE "public"."ocr_row_status" ADD VALUE 'FAILED';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "condicion_iva_receptor_id" integer;--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD COLUMN "error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issued_invoices_invoice_id_unique" ON "issued_invoices" USING btree ("invoice_id");