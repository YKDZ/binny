CREATE TABLE "runtime_containers" (
	"bin_id" text PRIMARY KEY,
	"compose_project" text NOT NULL,
	"compose_service" text NOT NULL,
	"container_id" text NOT NULL,
	"lifecycle_phase" text NOT NULL,
	"container_started_at" text,
	"stopped_container_finished_at" text,
	"idle_since" timestamp with time zone,
	"last_wake_error" jsonb,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "runtime_containers_lifecycle_phase_check" CHECK ("lifecycle_phase" in ('running', 'waking', 'stopping', 'sleeping', 'offline'))
);
--> statement-breakpoint
ALTER TABLE "bin_configurations" ADD COLUMN "runtime_sleep_idle_timeout_seconds" integer DEFAULT 300;--> statement-breakpoint
ALTER TABLE "runtime_containers" ADD CONSTRAINT "runtime_containers_bin_id_bin_configurations_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "bin_configurations" ADD CONSTRAINT "bin_configurations_runtime_sleep_idle_timeout_seconds_check" CHECK ("runtime_sleep_idle_timeout_seconds" between 0 and 2147483);--> statement-breakpoint
UPDATE "bin_configurations"
SET
  "runtime_sleep_idle_timeout_seconds" = CASE
    WHEN COALESCE(("source_adapter"->'environment'->'browser'->>'required')::boolean, false) = false THEN 300
    WHEN COALESCE(("source_adapter"->'environment'->'browser'->>'profileReuseAfterRestart')::boolean, false) = false THEN NULL
    ELSE "browser_idle_timeout_seconds"
  END,
  "browser_idle_timeout_seconds" = CASE
    WHEN COALESCE(("source_adapter"->'environment'->'browser'->>'required')::boolean, false) = false THEN 300
    WHEN COALESCE(("source_adapter"->'environment'->'browser'->>'profileReuseAfterRestart')::boolean, false) = false THEN NULL
    ELSE "browser_idle_timeout_seconds"
  END;