ALTER TABLE "manual_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "manual_runs" ADD COLUMN "stop_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD COLUMN "owner_state" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD COLUMN "owner_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "manual_runs_one_executing_bin_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "manual_runs_one_executing_bin_idx" ON "manual_runs" ("bin_id") WHERE "status" in ('executing', 'cancelling');--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD CONSTRAINT "runtime_connections_owner_state_check" CHECK ("owner_state" in ('confirmed', 'unconfirmed'));--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD CONSTRAINT "runtime_connections_owner_generation_check" CHECK ("owner_generation" >= 0);--> statement-breakpoint
ALTER TABLE "manual_runs" DROP CONSTRAINT "manual_runs_status_check", ADD CONSTRAINT "manual_runs_status_check" CHECK ("status" in ('queued', 'executing', 'cancelling', 'completed', 'failed', 'cancelled'));