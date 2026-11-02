ALTER TABLE "archive_commit" RENAME COLUMN "collector_version" TO "source_adapter_version";--> statement-breakpoint
ALTER TABLE "bin_configurations" RENAME COLUMN "collector" TO "source_adapter";--> statement-breakpoint
ALTER TABLE "manual_runs" RENAME COLUMN "collector_snapshot" TO "source_adapter_snapshot";--> statement-breakpoint
ALTER TABLE "manual_runs" RENAME COLUMN "collector_id" TO "source_adapter_id";--> statement-breakpoint
ALTER TABLE "manual_runs" RENAME COLUMN "collector_version" TO "source_adapter_version";--> statement-breakpoint
ALTER TABLE "runtime_connections" RENAME COLUMN "collector" TO "source_adapter";