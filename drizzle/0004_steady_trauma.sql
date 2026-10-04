ALTER TABLE "credentials" ADD COLUMN "scope" text DEFAULT 'singleton' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_singleton_unique" ON "credentials" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "delegations_client_unique" ON "delegations" USING btree ("client_id");