ALTER TABLE "comprobantes" ADD CONSTRAINT "comprobantes_incierto_require_number_check" CHECK ("estado" <> 'incierto' OR "cbte_nro" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "comprobantes_incierto_empresa_created_at_idx" ON "comprobantes" USING btree ("empresa_id", "created_at" DESC);
