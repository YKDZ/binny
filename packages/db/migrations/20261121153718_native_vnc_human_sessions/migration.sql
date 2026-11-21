ALTER TABLE "human_sessions" DROP CONSTRAINT "human_sessions_access_token_hash_key";--> statement-breakpoint
ALTER TABLE "human_sessions" ADD COLUMN "vnc_password_pending" text;--> statement-breakpoint
ALTER TABLE "human_sessions" DROP COLUMN "access_token_hash";--> statement-breakpoint
ALTER TABLE "human_sessions" DROP COLUMN "runtime_token_hash";--> statement-breakpoint
ALTER TABLE "human_sessions" DROP COLUMN "gateway_closed";