CREATE TABLE "ta_cache" (
	"service" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"sign" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"issued_at_ms" bigint NOT NULL
);
