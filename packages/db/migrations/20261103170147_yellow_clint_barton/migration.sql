ALTER TABLE "schedules" ADD COLUMN "overlap_policy" text DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_skip" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_overlap_policy_check" CHECK ("overlap_policy" in ('queue', 'skip'));