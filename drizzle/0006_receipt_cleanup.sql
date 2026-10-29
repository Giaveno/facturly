CREATE TABLE "receipt_cleanup" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "row_id" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "receipt_cleanup_row_id_unique" UNIQUE("row_id")
);
