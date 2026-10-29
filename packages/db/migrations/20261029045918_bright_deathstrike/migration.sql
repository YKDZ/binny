CREATE TABLE "browser_capacity_coordinator" (
	"coordinator_id" smallint PRIMARY KEY,
	CONSTRAINT "browser_capacity_coordinator_id_check" CHECK ("coordinator_id" = 1)
);
--> statement-breakpoint
CREATE TABLE "browser_capacity_reservation" (
	"reservation_id" uuid PRIMARY KEY,
	"bin_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"owner_generation" bigint NOT NULL,
	"requires_reservation_id" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "browser_capacity_reservation_owner_generation_check" CHECK ("owner_generation" > 0),
	CONSTRAINT "browser_capacity_reservation_status_check" CHECK ("status" in ('reserved', 'starting', 'ready', 'stopping', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "runtime_connections" ADD COLUMN "protocol_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_capacity_reservation_bin_id_key" ON "browser_capacity_reservation" ("bin_id");