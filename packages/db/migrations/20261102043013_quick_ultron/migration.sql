ALTER TABLE "bin_configurations" ADD COLUMN "config_native_valid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD COLUMN "runtime_control_url" text;