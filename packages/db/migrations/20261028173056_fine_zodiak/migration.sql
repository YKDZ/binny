CREATE TABLE "schedules" (
	"schedule_id" uuid PRIMARY KEY,
	"bin_id" text NOT NULL,
	"expression" text NOT NULL,
	"time_zone" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manual_runs" ADD COLUMN "trigger_type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_runs" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "manual_runs" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" ("next_due_at","bin_id","schedule_id") WHERE "enabled" = true;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_bin_id_bin_configurations_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin_configurations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "manual_runs" ADD CONSTRAINT "manual_runs_trigger_source_check" CHECK ((((("trigger_type" = 'manual') and (("schedule_id" is null)) and (("scheduled_for" is null)))) or ((("trigger_type" = 'schedule') and (("schedule_id" is not null)) and (("scheduled_for" is not null))))));