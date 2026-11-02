ALTER TABLE "manual_runs" ADD COLUMN "reference_time" timestamp with time zone;
UPDATE "manual_runs"
SET "reference_time" = COALESCE("scheduled_for", "created_at");
ALTER TABLE "manual_runs" ALTER COLUMN "reference_time" SET NOT NULL;
