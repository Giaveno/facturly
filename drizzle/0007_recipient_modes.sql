ALTER TABLE "ocr_rows" ADD COLUMN "recipient_mode" text;
--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD COLUMN "recipient_mode_source" text;
--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD COLUMN "tax_rate" numeric;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_rate" numeric;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "approval_snapshot" jsonb;
--> statement-breakpoint
-- Preserve known identified recipients and fiscal documents conservatively.
UPDATE "ocr_rows" r SET "recipient_mode" = CASE WHEN r."cuit" IS NOT NULL
 OR EXISTS (SELECT 1 FROM "invoices" i WHERE i."ocr_row_id" = r."id" AND i."receptor_doc_tipo" = 80)
 THEN 'identified' ELSE 'consumer_final' END, "recipient_mode_source" = 'legacy_migration';
--> statement-breakpoint
-- Newly interpreted recipient modes require fresh explicit human review.
UPDATE "invoices" SET "status" = 'PENDING' WHERE "status" = 'REVIEWED';
--> statement-breakpoint
ALTER TABLE "ocr_rows" ALTER COLUMN "recipient_mode" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "ocr_rows" ALTER COLUMN "recipient_mode" SET DEFAULT 'consumer_final';
--> statement-breakpoint
ALTER TABLE "ocr_rows" ALTER COLUMN "recipient_mode_source" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "ocr_rows" ALTER COLUMN "recipient_mode_source" SET DEFAULT 'upload_default';
--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD CONSTRAINT "ocr_rows_recipient_mode_check" CHECK ("recipient_mode" IN ('consumer_final', 'identified'));
--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD CONSTRAINT "ocr_rows_tax_rate_check" CHECK ("tax_rate" IN (10.5, 21, 27));
