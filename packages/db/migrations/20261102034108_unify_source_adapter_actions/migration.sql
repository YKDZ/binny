ALTER TABLE "manual_runs" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "manual_runs" DROP COLUMN "targets_snapshot";--> statement-breakpoint
ALTER TABLE "manual_runs" DROP COLUMN "check_result";--> statement-breakpoint
ALTER TABLE "bin_configurations" DROP COLUMN "targets";