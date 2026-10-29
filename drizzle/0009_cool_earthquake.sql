CREATE TYPE "public"."comprobante_ambiente" AS ENUM('homologacion', 'produccion');--> statement-breakpoint
CREATE TYPE "public"."comprobante_emisor_condicion_iva" AS ENUM('ri', 'monotributista', 'exento');--> statement-breakpoint
CREATE TYPE "public"."comprobante_estado" AS ENUM('borrador', 'pendiente', 'aprobado', 'rechazado', 'incierto');--> statement-breakpoint
CREATE TABLE "comprobantes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"ambiente" "comprobante_ambiente" NOT NULL,
	"emisor_cuit" text NOT NULL,
	"emisor_condicion_iva" "comprobante_emisor_condicion_iva" NOT NULL,
	"cbte_tipo" integer NOT NULL,
	"pto_vta" integer NOT NULL,
	"cbte_nro" bigint,
	"concepto" integer DEFAULT 1 NOT NULL,
	"doc_tipo" integer NOT NULL,
	"doc_nro" text NOT NULL,
	"condicion_iva_receptor" integer NOT NULL,
	"fecha" date NOT NULL,
	"importe_neto_centavos" bigint NOT NULL,
	"importe_iva_centavos" bigint NOT NULL,
	"importe_exento_centavos" bigint NOT NULL,
	"importe_tributos_centavos" bigint NOT NULL,
	"importe_total_centavos" bigint NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estado" "comprobante_estado" DEFAULT 'borrador' NOT NULL,
	"cae" text,
	"cae_vto" date,
	"resultado" text,
	"observaciones" text,
	"errores" text,
	"idempotency_key" text NOT NULL,
	"comprobante_asociado_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "comprobantes_emisor_cuit_check" CHECK ("comprobantes"."emisor_cuit" ~ '^[0-9]{11}$'),
	CONSTRAINT "comprobantes_pto_vta_check" CHECK ("comprobantes"."pto_vta" BETWEEN 1 AND 99999),
	CONSTRAINT "comprobantes_cbte_nro_check" CHECK ("comprobantes"."cbte_nro" IS NULL OR "comprobantes"."cbte_nro" BETWEEN 1 AND 99999999),
	CONSTRAINT "comprobantes_concepto_check" CHECK ("comprobantes"."concepto" IN (1, 2, 3)),
	CONSTRAINT "comprobantes_aprobado_requirements_check" CHECK ("comprobantes"."estado" <> 'aprobado' OR ("comprobantes"."cae" IS NOT NULL AND "comprobantes"."cae_vto" IS NOT NULL AND "comprobantes"."cbte_nro" IS NOT NULL)),
	CONSTRAINT "comprobantes_pendiente_requirements_check" CHECK ("comprobantes"."estado" <> 'pendiente' OR "comprobantes"."cbte_nro" IS NOT NULL),
	CONSTRAINT "comprobantes_importes_non_negative_check" CHECK ("comprobantes"."importe_neto_centavos" >= 0 AND "comprobantes"."importe_iva_centavos" >= 0 AND "comprobantes"."importe_exento_centavos" >= 0 AND "comprobantes"."importe_tributos_centavos" >= 0 AND "comprobantes"."importe_total_centavos" >= 0),
	CONSTRAINT "comprobantes_importes_total_check" CHECK ("comprobantes"."importe_total_centavos" = "comprobantes"."importe_neto_centavos" + "comprobantes"."importe_iva_centavos" + "comprobantes"."importe_exento_centavos" + "comprobantes"."importe_tributos_centavos")
);
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_empresa_id_clients_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_comprobante_asociado_id_comprobantes_id_fk" FOREIGN KEY ("comprobante_asociado_id") REFERENCES "public"."comprobantes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comprobantes_idempotency_key_unique" ON "comprobantes" USING btree ("empresa_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "comprobantes_fiscal_identity_unique" ON "comprobantes" USING btree ("ambiente","emisor_cuit","pto_vta","cbte_tipo","cbte_nro") WHERE "comprobantes"."cbte_nro" IS NOT NULL AND "comprobantes"."estado" <> 'rechazado';