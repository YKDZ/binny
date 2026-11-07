ALTER TABLE "bin_configurations" ADD COLUMN "persistent_state" jsonb;--> statement-breakpoint
ALTER TABLE "bin_configurations" ADD COLUMN "source_access_state" jsonb;--> statement-breakpoint
ALTER TABLE "bin_configurations" ADD COLUMN "last_issued_owner_generation" text DEFAULT '0' NOT NULL;