CREATE TYPE "public"."condicion_iva" AS ENUM('ri', 'monotributista', 'exento', 'consumidorFinal');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('PENDING', 'REVIEWED', 'APPROVED', 'EMITTING', 'EMITTED', 'REJECTED', 'EMIT_ERROR');--> statement-breakpoint
CREATE TYPE "public"."ocr_row_status" AS ENUM('PENDING', 'CONFIDENT', 'BLOCKED', 'CORRECTED');--> statement-breakpoint
CREATE TABLE "accountant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "accountant_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"invoice_id" uuid,
	"row_id" uuid
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cuit" text NOT NULL,
	"razon_social" text NOT NULL,
	"pto_vta" integer NOT NULL,
	"condicion_iva" "condicion_iva" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cert_pem" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"cuit" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ocr_row_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "invoice_status" DEFAULT 'PENDING' NOT NULL,
	"cbte_tipo" integer,
	"discard_reason" text,
	"receptor_doc_tipo" integer,
	"receptor_doc_nro" bigint,
	"receptor_razon_social" text,
	"fecha_emision" date,
	"fecha_vto" date,
	"moneda" text,
	"cotizacion" numeric,
	"importe_neto_centavos" bigint,
	"importe_iva_centavos" bigint,
	"importe_total_centavos" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_cbte_tipo_check" CHECK ("invoices"."cbte_tipo" IN (1, 6, 11))
);
--> statement-breakpoint
CREATE TABLE "issued_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"cuit" text NOT NULL,
	"pto_vta" integer NOT NULL,
	"cbte_tipo" integer NOT NULL,
	"cbte_nro" bigint NOT NULL,
	"cae" text NOT NULL,
	"cae_fch_vto" date NOT NULL,
	"importe_total_centavos" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocr_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"confidence" jsonb NOT NULL,
	"cuit" text,
	"status" "ocr_row_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cbu" text,
	"cvu" text,
	"alias" text,
	"name" text NOT NULL,
	"cuit" text,
	"learned_from" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_row_id_ocr_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."ocr_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_ocr_row_id_ocr_rows_id_fk" FOREIGN KEY ("ocr_row_id") REFERENCES "public"."ocr_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_invoices" ADD CONSTRAINT "issued_invoices_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocr_rows" ADD CONSTRAINT "ocr_rows_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_cuit_unique" ON "clients" USING btree ("cuit");--> statement-breakpoint
CREATE UNIQUE INDEX "issued_invoices_idempotency" ON "issued_invoices" USING btree ("cuit","pto_vta","cbte_tipo","cbte_nro");--> statement-breakpoint
CREATE UNIQUE INDEX "payers_cbu_unique" ON "payers" USING btree ("cbu") WHERE "payers"."cbu" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payers_cvu_unique" ON "payers" USING btree ("cvu") WHERE "payers"."cvu" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payers_alias_unique" ON "payers" USING btree ("alias") WHERE "payers"."alias" IS NOT NULL;