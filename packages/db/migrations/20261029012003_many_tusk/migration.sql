CREATE TABLE "human_sessions" (
	"session_id" uuid PRIMARY KEY,
	"bin_id" text NOT NULL,
	"access_token_hash" text NOT NULL UNIQUE,
	"status" text DEFAULT 'pending' NOT NULL,
	"runtime_id" text,
	"owner_generation" bigint,
	"runtime_token_hash" text,
	"gateway_closed" boolean DEFAULT false NOT NULL,
	"runtime_closed" boolean DEFAULT false NOT NULL,
	"failure" jsonb,
	"requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"ready_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "human_sessions_status_check" CHECK ("status" in ('pending', 'opening', 'ready', 'closing', 'closed', 'failed')),
	CONSTRAINT "human_sessions_owner_generation_check" CHECK (((("owner_generation" is null)) or ("owner_generation" >= 1)))
);
--> statement-breakpoint
CREATE INDEX "human_sessions_bin_status_idx" ON "human_sessions" ("bin_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "human_sessions_one_active_bin_idx" ON "human_sessions" ("bin_id") WHERE "status" in ('pending', 'opening', 'ready', 'closing');--> statement-breakpoint
ALTER TABLE "human_sessions" ADD CONSTRAINT "human_sessions_bin_id_bin_configurations_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin_configurations"("id") ON DELETE CASCADE;