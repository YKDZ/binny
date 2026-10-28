-- pg_trgm 扩展没有 RC schema 实体；其 operator class 被正文 GIN 索引引用。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "archive_commit" (
	"commit_id" uuid PRIMARY KEY,
	"archive_seq" bigint NOT NULL UNIQUE,
	"bin_id" text NOT NULL,
	"run_id" text,
	"collector_version" text,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "archive_commit_archive_seq_check" CHECK ("archive_seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "archive_item_deletion" (
	"item_id" uuid PRIMARY KEY,
	"namespace" text NOT NULL,
	"source_key" text NOT NULL,
	"deletion_seq" bigint NOT NULL,
	CONSTRAINT "archive_item_deletion_deletion_seq_check" CHECK ("deletion_seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "archive_item_observation_gap" (
	"commit_id" uuid,
	"ordinal" integer,
	"item_id" uuid NOT NULL,
	CONSTRAINT "archive_item_observation_gap_pkey" PRIMARY KEY("commit_id","ordinal"),
	CONSTRAINT "archive_item_observation_gap_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "archive_item" (
	"item_id" uuid PRIMARY KEY,
	"namespace" text NOT NULL,
	"source_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "archive_item_namespace_source_key_key" UNIQUE("namespace","source_key")
);
--> statement-breakpoint
CREATE TABLE "archive_observation" (
	"commit_id" uuid,
	"ordinal" integer,
	"item_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"diagnostics" jsonb,
	CONSTRAINT "archive_observation_pkey" PRIMARY KEY("commit_id","ordinal"),
	CONSTRAINT "archive_observation_commit_id_item_id_key" UNIQUE("commit_id","item_id"),
	CONSTRAINT "archive_observation_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "archive_relation_observation_gap" (
	"commit_id" uuid,
	"ordinal" integer,
	"relation_id" text NOT NULL,
	"from_item_id" uuid NOT NULL,
	"target_item_id" uuid,
	CONSTRAINT "archive_relation_observation_gap_pkey" PRIMARY KEY("commit_id","ordinal"),
	CONSTRAINT "archive_relation_observation_gap_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "archive_relation_observation" (
	"commit_id" uuid,
	"ordinal" integer,
	"relation_id" text NOT NULL,
	"bin_id" text NOT NULL,
	"archive_seq" bigint NOT NULL,
	"relation_revision_id" uuid,
	CONSTRAINT "archive_relation_observation_pkey" PRIMARY KEY("commit_id","ordinal"),
	CONSTRAINT "archive_relation_observation_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "archive_relation_revision" (
	"relation_revision_id" uuid PRIMARY KEY,
	"relation_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"state_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "archive_relation_revision_relation_id_state_hash_key" UNIQUE("relation_id","state_hash"),
	CONSTRAINT "archive_relation_revision_relation_id_relation_revision_id_key" UNIQUE("relation_id","relation_revision_id"),
	CONSTRAINT "archive_relation_revision_state_hash_check" CHECK (length("state_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "archive_relation" (
	"relation_id" text PRIMARY KEY,
	"from_item_id" uuid NOT NULL,
	"target_item_id" uuid,
	"target_source_ref" text,
	"created_seq" bigint NOT NULL,
	CONSTRAINT "archive_relation_target_check" CHECK (("target_item_id" is null) <> ("target_source_ref" is null))
);
--> statement-breakpoint
CREATE TABLE "archive_request_receipt" (
	"request_id" text PRIMARY KEY,
	"payload_hash" text NOT NULL,
	"commit_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "archive_request_receipt_payload_hash_check" CHECK (length("payload_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "archive_resource" (
	"resource_id" uuid PRIMARY KEY,
	"sha256" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" uuid NOT NULL UNIQUE,
	"status" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "archive_resource_sha256_check" CHECK (length("sha256") = 64),
	CONSTRAINT "archive_resource_byte_size_check" CHECK ("byte_size" >= 0),
	CONSTRAINT "archive_resource_status_check" CHECK ("status" in ('ready', 'deleting'))
);
--> statement-breakpoint
CREATE TABLE "archive_revision_resource" (
	"revision_id" uuid,
	"resource_id" uuid,
	"ordinal" integer NOT NULL,
	CONSTRAINT "archive_revision_resource_pkey" PRIMARY KEY("revision_id","resource_id"),
	CONSTRAINT "archive_revision_resource_revision_id_ordinal_key" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "archive_revision_resource_ordinal_check" CHECK ("ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "archive_revision" (
	"revision_id" uuid PRIMARY KEY,
	"item_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"state_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "archive_revision_item_id_state_hash_key" UNIQUE("item_id","state_hash"),
	CONSTRAINT "archive_revision_item_id_revision_id_key" UNIQUE("item_id","revision_id"),
	CONSTRAINT "archive_revision_state_hash_check" CHECK (length("state_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "archive_write_clock" (
	"clock_id" smallint PRIMARY KEY,
	"last_seq" bigint NOT NULL,
	CONSTRAINT "archive_write_clock_clock_id_check" CHECK ("clock_id" = 1),
	CONSTRAINT "archive_write_clock_last_seq_check" CHECK ("last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bin_configurations" (
	"id" text PRIMARY KEY,
	"collector" jsonb NOT NULL,
	"identity_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bin_configurations_status_check" CHECK ("status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "manual_runs" (
	"run_id" uuid PRIMARY KEY,
	"bin_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"collector_snapshot" jsonb NOT NULL,
	"collector_id" text NOT NULL,
	"collector_version" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"targets_snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"runtime_id" text,
	"completed_scopes" jsonb DEFAULT '[]' NOT NULL,
	"failure" jsonb,
	"check_result" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "manual_runs_status_check" CHECK ("status" in ('queued', 'executing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "runtime_connections" (
	"bin_id" text PRIMARY KEY,
	"runtime_id" text NOT NULL,
	"collector" jsonb NOT NULL,
	"environment" jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "archive_commit_id_bin_seq_idx" ON "archive_commit" ("commit_id","bin_id","archive_seq");--> statement-breakpoint
CREATE INDEX "archive_commit_bin_sequence_idx" ON "archive_commit" ("bin_id","archive_seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "archive_item_observation_gap_item_commit_idx" ON "archive_item_observation_gap" ("item_id","commit_id");--> statement-breakpoint
CREATE INDEX "archive_observation_item_commit_idx" ON "archive_observation" ("item_id","commit_id");--> statement-breakpoint
CREATE INDEX "archive_relation_observation_gap_from_idx" ON "archive_relation_observation_gap" ("from_item_id","relation_id");--> statement-breakpoint
CREATE INDEX "archive_relation_observation_gap_to_idx" ON "archive_relation_observation_gap" ("target_item_id","relation_id") WHERE ("target_item_id" is not null);--> statement-breakpoint
CREATE INDEX "archive_relation_observation_gap_id_commit_idx" ON "archive_relation_observation_gap" ("relation_id","commit_id");--> statement-breakpoint
CREATE INDEX "archive_relation_observation_latest_idx" ON "archive_relation_observation" ("relation_id","bin_id","archive_seq" DESC NULLS LAST,"ordinal" DESC NULLS LAST,"commit_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "archive_relation_from_item_idx" ON "archive_relation" ("from_item_id","relation_id");--> statement-breakpoint
CREATE INDEX "archive_relation_to_item_idx" ON "archive_relation" ("target_item_id","relation_id") WHERE ("target_item_id" is not null);--> statement-breakpoint
CREATE INDEX "archive_resource_digest_idx" ON "archive_resource" ("sha256","byte_size") WHERE "status" = 'ready';--> statement-breakpoint
CREATE INDEX "archive_resource_cleanup_idx" ON "archive_resource" ("uploaded_at") WHERE "status" = 'ready';--> statement-breakpoint
CREATE INDEX "archive_revision_resource_resource_idx" ON "archive_revision_resource" ("resource_id","revision_id");--> statement-breakpoint
CREATE INDEX "archive_revision_search_text_trgm_idx" ON "archive_revision" USING gin (("state_data"->'body'->>'searchText') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "manual_runs_bin_queue_idx" ON "manual_runs" ("bin_id","created_at","run_id") WHERE "status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "manual_runs_one_executing_bin_idx" ON "manual_runs" ("bin_id") WHERE "status" = 'executing';--> statement-breakpoint
ALTER TABLE "archive_item_observation_gap" ADD CONSTRAINT "archive_item_observation_gap_T3HeKGOQ3cZv_fkey" FOREIGN KEY ("commit_id") REFERENCES "archive_commit"("commit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_item_observation_gap" ADD CONSTRAINT "archive_item_observation_gap_kyK0FxbeSzP0_fkey" FOREIGN KEY ("item_id") REFERENCES "archive_item_deletion"("item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_observation" ADD CONSTRAINT "archive_observation_commit_id_archive_commit_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "archive_commit"("commit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_observation" ADD CONSTRAINT "archive_observation_item_id_archive_item_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "archive_item"("item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_observation" ADD CONSTRAINT "archive_observation_CbOC21ZZ2owS_fkey" FOREIGN KEY ("item_id","revision_id") REFERENCES "archive_revision"("item_id","revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation_observation_gap" ADD CONSTRAINT "archive_relation_observation_gap_bzqp1pxC1qK8_fkey" FOREIGN KEY ("commit_id") REFERENCES "archive_commit"("commit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation_observation" ADD CONSTRAINT "archive_relation_observation_cRQG0RHldkI4_fkey" FOREIGN KEY ("relation_id") REFERENCES "archive_relation"("relation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation_observation" ADD CONSTRAINT "archive_relation_observation_ayR75R0bkScT_fkey" FOREIGN KEY ("commit_id","bin_id","archive_seq") REFERENCES "archive_commit"("commit_id","bin_id","archive_seq") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation_observation" ADD CONSTRAINT "archive_relation_observation_UwcY5ULnwpqc_fkey" FOREIGN KEY ("relation_id","relation_revision_id") REFERENCES "archive_relation_revision"("relation_id","relation_revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation_revision" ADD CONSTRAINT "archive_relation_revision_vqrF1nfEFjDx_fkey" FOREIGN KEY ("relation_id") REFERENCES "archive_relation"("relation_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation" ADD CONSTRAINT "archive_relation_from_item_id_archive_item_item_id_fkey" FOREIGN KEY ("from_item_id") REFERENCES "archive_item"("item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation" ADD CONSTRAINT "archive_relation_target_item_id_archive_item_item_id_fkey" FOREIGN KEY ("target_item_id") REFERENCES "archive_item"("item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_relation" ADD CONSTRAINT "archive_relation_created_seq_archive_commit_archive_seq_fkey" FOREIGN KEY ("created_seq") REFERENCES "archive_commit"("archive_seq") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_request_receipt" ADD CONSTRAINT "archive_request_receipt_commit_id_archive_commit_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "archive_commit"("commit_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_revision_resource" ADD CONSTRAINT "archive_revision_resource_kkiObShf0M5C_fkey" FOREIGN KEY ("revision_id") REFERENCES "archive_revision"("revision_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_revision_resource" ADD CONSTRAINT "archive_revision_resource_RIQKIIVHFSif_fkey" FOREIGN KEY ("resource_id") REFERENCES "archive_resource"("resource_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "archive_revision" ADD CONSTRAINT "archive_revision_item_id_archive_item_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "archive_item"("item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD CONSTRAINT "runtime_connections_bin_id_bin_configurations_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "bin_configurations"("id") ON DELETE CASCADE;
