ALTER TABLE "emission_series_claims" ADD COLUMN "uncertain_since_ms" bigint;--> statement-breakpoint
UPDATE "emission_series_claims" SET "uncertain_since_ms" = "lease_expires_at_ms" WHERE "uncertain" = true AND "uncertain_since_ms" IS NULL;
