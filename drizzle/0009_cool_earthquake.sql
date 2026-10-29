CREATE TYPE "public"."comprobante_emisor_condicion_iva" AS ENUM('ri', 'monotributista', 'exento');--> statement-breakpoint
CREATE TYPE "public"."comprobante_estado" AS ENUM('borrador', 'pendiente', 'aprobado', 'rechazado', 'incierto');--> statement-breakpoint
CREATE TABLE "comprobantes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
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
	"cbte_asociado" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "comprobantes_pto_vta_check" CHECK ("comprobantes"."pto_vta" BETWEEN 1 AND 99999),
	CONSTRAINT "comprobantes_cbte_nro_check" CHECK ("comprobantes"."cbte_nro" IS NULL OR "comprobantes"."cbte_nro" BETWEEN 1 AND 9999999),
	CONSTRAINT "comprobantes_concepto_check" CHECK ("comprobantes"."concepto" IN (1, 2, 3)),
	CONSTRAINT "comprobantes_doc_tipo_check" CHECK ("comprobantes"."doc_tipo" IN (80, 86, 87, 89, 90, 91, 92, 93, 94, 95, 96, 99)),
	CONSTRAINT "comprobantes_condicion_iva_receptor_check" CHECK ("comprobantes"."condicion_iva_receptor" IN (1, 4, 5, 6)),
	CONSTRAINT "comprobantes_doc_99_condicion_check" CHECK ("comprobantes"."doc_tipo" <> 99 OR "comprobantes"."condicion_iva_receptor" = 5),
	CONSTRAINT "comprobantes_importes_non_negative_check" CHECK ("comprobantes"."importe_neto_centavos" >= 0 AND "comprobantes"."importe_iva_centavos" >= 0 AND "comprobantes"."importe_exento_centavos" >= 0 AND "comprobantes"."importe_tributos_centavos" >= 0 AND "comprobantes"."importe_total_centavos" >= 0),
	CONSTRAINT "comprobantes_importes_total_check" CHECK ("comprobantes"."importe_total_centavos" = "comprobantes"."importe_neto_centavos" + "comprobantes"."importe_iva_centavos" + "comprobantes"."importe_exento_centavos" + "comprobantes"."importe_tributos_centavos")
);
--> statement-breakpoint
ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_empresa_id_clients_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comprobantes_idempotency_key_unique" ON "comprobantes" USING btree ("idempotency_key");