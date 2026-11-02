import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const binConfigurationStatuses = ["active", "disabled"] as const;
const archiveResourceStatuses = ["ready", "deleting"] as const;
const manualRunStatuses = [
  "queued",
  "executing",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;
const manualRunTriggerTypes = ["manual", "schedule"] as const;
const runtimeOwnerStates = ["confirmed", "unconfirmed"] as const;
const browserCapacityReservationStates = [
  "reserved",
  "starting",
  "ready",
  "stopping",
  "unknown",
] as const;
const humanSessionStatuses = [
  "pending",
  "opening",
  "ready",
  "closing",
  "closed",
  "failed",
] as const;

// PostgreSQL 内置目录视图只读时区名称；`.existing()` 防止 Kit 为系统对象生成迁移。
export const postgresTimeZones = pgView("pg_timezone_names", {
  name: text("name").notNull(),
}).existing();

export const binConfigurations = pgTable(
  "bin_configurations",
  {
    id: text("id").primaryKey(),
    sourceAdapter: jsonb("source_adapter").notNull(),
    identityId: text("identity_id").notNull(),
    config: jsonb("config").notNull(),
    configNativeValid: boolean("config_native_valid").notNull().default(true),
    browserIdleTimeoutSeconds: integer("browser_idle_timeout_seconds").default(
      300,
    ),
    status: text("status", { enum: binConfigurationStatuses }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "bin_configurations_status_check",
      inArray(table.status, binConfigurationStatuses),
    ),
    check(
      "bin_configurations_browser_idle_timeout_seconds_check",
      sql`${table.browserIdleTimeoutSeconds} between 0 and 2147483`,
    ),
  ],
);

export const runtimeConnections = pgTable(
  "runtime_connections",
  {
    binId: text("bin_id")
      .primaryKey()
      .references(() => binConfigurations.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id").notNull(),
    sourceAdapter: jsonb("source_adapter").notNull(),
    environment: jsonb("environment").notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    disconnected: boolean("disconnected").notNull().default(false),
    protocolVersion: smallint("protocol_version").notNull().default(0),
    runtimeControlUrl: text("runtime_control_url"),
    ownerState: text("owner_state", { enum: runtimeOwnerStates })
      .notNull()
      .default("confirmed"),
    ownerGeneration: bigint("owner_generation", { mode: "bigint" })
      .notNull()
      .default(0n),
  },
  (table) => [
    check(
      "runtime_connections_owner_state_check",
      inArray(table.ownerState, runtimeOwnerStates),
    ),
    check(
      "runtime_connections_owner_generation_check",
      gte(table.ownerGeneration, 0n),
    ),
  ],
);

export const browserCapacityCoordinator = pgTable(
  "browser_capacity_coordinator",
  {
    coordinatorId: smallint("coordinator_id").primaryKey(),
  },
  (table) => [
    check("browser_capacity_coordinator_id_check", eq(table.coordinatorId, 1)),
  ],
);

export const browserCapacityReservations = pgTable(
  "browser_capacity_reservation",
  {
    reservationId: uuid("reservation_id").primaryKey(),
    // 不引用 bin 配置：活动浏览器的容量占位不能随配置级联删除。
    binId: text("bin_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    ownerGeneration: bigint("owner_generation", { mode: "bigint" }).notNull(),
    // 迁移前创建的旧 controller 不认识尝试 ID；新预约始终要求精确确认。
    requiresReservationId: boolean("requires_reservation_id")
      .notNull()
      .default(true),
    status: text("status", {
      enum: browserCapacityReservationStates,
    }).notNull(),
  },
  (table) => [
    check(
      "browser_capacity_reservation_owner_generation_check",
      gt(table.ownerGeneration, 0n),
    ),
    check(
      "browser_capacity_reservation_status_check",
      inArray(table.status, browserCapacityReservationStates),
    ),
    uniqueIndex("browser_capacity_reservation_bin_id_key").on(table.binId),
  ],
);

export const humanSessions = pgTable(
  "human_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    binId: text("bin_id")
      .notNull()
      .references(() => binConfigurations.id, { onDelete: "cascade" }),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    status: text("status", { enum: humanSessionStatuses })
      .notNull()
      .default("pending"),
    runtimeId: text("runtime_id"),
    ownerGeneration: bigint("owner_generation", { mode: "bigint" }),
    runtimeTokenHash: text("runtime_token_hash"),
    gatewayClosed: boolean("gateway_closed").notNull().default(false),
    runtimeClosed: boolean("runtime_closed").notNull().default(false),
    failure: jsonb("failure"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    readyAt: timestamp("ready_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check(
      "human_sessions_status_check",
      inArray(table.status, humanSessionStatuses),
    ),
    check(
      "human_sessions_owner_generation_check",
      or(isNull(table.ownerGeneration), gte(table.ownerGeneration, 1n))!,
    ),
    index("human_sessions_bin_status_idx").on(table.binId, table.status),
    uniqueIndex("human_sessions_one_active_bin_idx")
      .on(table.binId)
      .where(inArray(table.status, ["pending", "opening", "ready", "closing"])),
  ],
);

export const archiveWriteClock = pgTable(
  "archive_write_clock",
  {
    clockId: smallint("clock_id").primaryKey(),
    lastSequence: bigint("last_seq", { mode: "bigint" }).notNull(),
  },
  (table) => [
    check("archive_write_clock_clock_id_check", eq(table.clockId, 1)),
    check("archive_write_clock_last_seq_check", gte(table.lastSequence, 0n)),
  ],
);

export const archiveItems = pgTable(
  "archive_item",
  {
    itemId: uuid("item_id").primaryKey(),
    namespace: text("namespace").notNull(),
    sourceKey: text("source_key").notNull(),
    // 现有契约使用实际墙钟时间；RC 的 defaultNow() 对应 now()。
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique("archive_item_namespace_source_key_key").on(
      table.namespace,
      table.sourceKey,
    ),
  ],
);

export const archiveItemDeletions = pgTable(
  "archive_item_deletion",
  {
    itemId: uuid("item_id").primaryKey(),
    namespace: text("namespace").notNull(),
    sourceKey: text("source_key").notNull(),
    deletionSequence: bigint("deletion_seq", { mode: "bigint" }).notNull(),
  },
  (table) => [
    check(
      "archive_item_deletion_deletion_seq_check",
      gt(table.deletionSequence, 0n),
    ),
  ],
);

export const archiveResources = pgTable(
  "archive_resource",
  {
    resourceId: uuid("resource_id").primaryKey(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
    storageKey: uuid("storage_key").notNull().unique(),
    status: text("status", { enum: archiveResourceStatuses }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check("archive_resource_sha256_check", sql`length(${table.sha256}) = 64`),
    check("archive_resource_byte_size_check", gte(table.byteSize, 0n)),
    check(
      "archive_resource_status_check",
      inArray(table.status, archiveResourceStatuses),
    ),
    index("archive_resource_digest_idx")
      .on(table.sha256, table.byteSize)
      .where(eq(table.status, "ready")),
    index("archive_resource_cleanup_idx")
      .on(table.uploadedAt)
      .where(eq(table.status, "ready")),
  ],
);

export const archiveRevisions = pgTable(
  "archive_revision",
  {
    revisionId: uuid("revision_id").primaryKey(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => archiveItems.itemId, { onDelete: "restrict" }),
    stateHash: text("state_hash").notNull(),
    stateData: jsonb("state_data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check(
      "archive_revision_state_hash_check",
      sql`length(${table.stateHash}) = 64`,
    ),
    unique("archive_revision_item_id_state_hash_key").on(
      table.itemId,
      table.stateHash,
    ),
    unique("archive_revision_item_id_revision_id_key").on(
      table.itemId,
      table.revisionId,
    ),
    index("archive_revision_search_text_trgm_idx").using(
      "gin",
      // RC 没有 pg_trgm 扩展实体；迁移先安装扩展，再以此表达式索引 JSON 正文。
      sql`(${table.stateData}->'body'->>'searchText') gin_trgm_ops`,
    ),
  ],
);

export const archiveRevisionResources = pgTable(
  "archive_revision_resource",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => archiveRevisions.revisionId, { onDelete: "restrict" }),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => archiveResources.resourceId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    check("archive_revision_resource_ordinal_check", gte(table.ordinal, 0)),
    primaryKey({ columns: [table.revisionId, table.resourceId] }),
    unique("archive_revision_resource_revision_id_ordinal_key").on(
      table.revisionId,
      table.ordinal,
    ),
    index("archive_revision_resource_resource_idx").on(
      table.resourceId,
      table.revisionId,
    ),
  ],
);

export const archiveCommits = pgTable(
  "archive_commit",
  {
    commitId: uuid("commit_id").primaryKey(),
    archiveSequence: bigint("archive_seq", { mode: "bigint" })
      .notNull()
      .unique(),
    // 归档保留 bin ID 值；删除配置不能级联删除归档。
    binId: text("bin_id").notNull(),
    runId: text("run_id"),
    sourceAdapterVersion: text("source_adapter_version"),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    recordedAt: timestamp("recorded_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    check("archive_commit_archive_seq_check", gt(table.archiveSequence, 0n)),
    uniqueIndex("archive_commit_id_bin_seq_idx").on(
      table.commitId,
      table.binId,
      table.archiveSequence,
    ),
    index("archive_commit_bin_sequence_idx").on(
      table.binId,
      table.archiveSequence.desc(),
    ),
  ],
);

export const archiveObservations = pgTable(
  "archive_observation",
  {
    commitId: uuid("commit_id")
      .notNull()
      .references(() => archiveCommits.commitId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => archiveItems.itemId, { onDelete: "restrict" }),
    revisionId: uuid("revision_id").notNull(),
    diagnostics: jsonb("diagnostics"),
  },
  (table) => [
    check("archive_observation_ordinal_check", gte(table.ordinal, 0)),
    primaryKey({ columns: [table.commitId, table.ordinal] }),
    unique("archive_observation_commit_id_item_id_key").on(
      table.commitId,
      table.itemId,
    ),
    foreignKey({
      columns: [table.itemId, table.revisionId],
      foreignColumns: [archiveRevisions.itemId, archiveRevisions.revisionId],
    }).onDelete("restrict"),
    index("archive_observation_item_commit_idx").on(
      table.itemId,
      table.commitId,
    ),
  ],
);

export const archiveItemObservationGaps = pgTable(
  "archive_item_observation_gap",
  {
    commitId: uuid("commit_id")
      .notNull()
      .references(() => archiveCommits.commitId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => archiveItemDeletions.itemId, { onDelete: "restrict" }),
  },
  (table) => [
    check("archive_item_observation_gap_ordinal_check", gte(table.ordinal, 0)),
    primaryKey({ columns: [table.commitId, table.ordinal] }),
    index("archive_item_observation_gap_item_commit_idx").on(
      table.itemId,
      table.commitId,
    ),
  ],
);

export const archiveRequestReceipts = pgTable(
  "archive_request_receipt",
  {
    requestId: text("request_id").primaryKey(),
    payloadHash: text("payload_hash").notNull(),
    commitId: uuid("commit_id")
      .notNull()
      .references(() => archiveCommits.commitId, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check(
      "archive_request_receipt_payload_hash_check",
      sql`length(${table.payloadHash}) = 64`,
    ),
  ],
);

export const archiveRelations = pgTable(
  "archive_relation",
  {
    relationId: text("relation_id").primaryKey(),
    fromItemId: uuid("from_item_id")
      .notNull()
      .references(() => archiveItems.itemId, { onDelete: "restrict" }),
    targetItemId: uuid("target_item_id").references(() => archiveItems.itemId, {
      onDelete: "restrict",
    }),
    targetSourceRef: text("target_source_ref"),
    createdSequence: bigint("created_seq", { mode: "bigint" })
      .notNull()
      .references(() => archiveCommits.archiveSequence, {
        onDelete: "restrict",
      }),
  },
  (table) => [
    check(
      "archive_relation_target_check",
      ne(isNull(table.targetItemId), isNull(table.targetSourceRef)),
    ),
    index("archive_relation_from_item_idx").on(
      table.fromItemId,
      table.relationId,
    ),
    index("archive_relation_to_item_idx")
      .on(table.targetItemId, table.relationId)
      .where(isNotNull(table.targetItemId)),
  ],
);

export const archiveRelationRevisions = pgTable(
  "archive_relation_revision",
  {
    relationRevisionId: uuid("relation_revision_id").primaryKey(),
    relationId: text("relation_id")
      .notNull()
      .references(() => archiveRelations.relationId, { onDelete: "restrict" }),
    stateHash: text("state_hash").notNull(),
    stateData: jsonb("state_data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check(
      "archive_relation_revision_state_hash_check",
      sql`length(${table.stateHash}) = 64`,
    ),
    unique("archive_relation_revision_relation_id_state_hash_key").on(
      table.relationId,
      table.stateHash,
    ),
    unique("archive_relation_revision_relation_id_relation_revision_id_key").on(
      table.relationId,
      table.relationRevisionId,
    ),
  ],
);

export const archiveRelationObservations = pgTable(
  "archive_relation_observation",
  {
    commitId: uuid("commit_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    relationId: text("relation_id")
      .notNull()
      .references(() => archiveRelations.relationId, { onDelete: "restrict" }),
    binId: text("bin_id").notNull(),
    archiveSequence: bigint("archive_seq", { mode: "bigint" }).notNull(),
    relationRevisionId: uuid("relation_revision_id"),
  },
  (table) => [
    check("archive_relation_observation_ordinal_check", gte(table.ordinal, 0)),
    primaryKey({ columns: [table.commitId, table.ordinal] }),
    foreignKey({
      columns: [table.commitId, table.binId, table.archiveSequence],
      foreignColumns: [
        archiveCommits.commitId,
        archiveCommits.binId,
        archiveCommits.archiveSequence,
      ],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.relationId, table.relationRevisionId],
      foreignColumns: [
        archiveRelationRevisions.relationId,
        archiveRelationRevisions.relationRevisionId,
      ],
    }).onDelete("restrict"),
    index("archive_relation_observation_latest_idx").on(
      table.relationId,
      table.binId,
      table.archiveSequence.desc(),
      table.ordinal.desc(),
      table.commitId.desc(),
    ),
  ],
);

export const archiveRelationObservationGaps = pgTable(
  "archive_relation_observation_gap",
  {
    commitId: uuid("commit_id")
      .notNull()
      .references(() => archiveCommits.commitId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    relationId: text("relation_id").notNull(),
    fromItemId: uuid("from_item_id").notNull(),
    targetItemId: uuid("target_item_id"),
  },
  (table) => [
    check(
      "archive_relation_observation_gap_ordinal_check",
      gte(table.ordinal, 0),
    ),
    primaryKey({ columns: [table.commitId, table.ordinal] }),
    index("archive_relation_observation_gap_from_idx").on(
      table.fromItemId,
      table.relationId,
    ),
    index("archive_relation_observation_gap_to_idx")
      .on(table.targetItemId, table.relationId)
      .where(isNotNull(table.targetItemId)),
    index("archive_relation_observation_gap_id_commit_idx").on(
      table.relationId,
      table.commitId,
    ),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    scheduleId: uuid("schedule_id").primaryKey(),
    binId: text("bin_id")
      .notNull()
      .references(() => binConfigurations.id, { onDelete: "cascade" }),
    expression: text("expression").notNull(),
    timeZone: text("time_zone").notNull(),
    action: text("action").notNull(),
    params: jsonb("params").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextDueAt: timestamp("next_due_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastError: jsonb("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index("schedules_due_idx")
      .on(table.nextDueAt, table.binId, table.scheduleId)
      .where(eq(table.enabled, true)),
  ],
);

export const manualRuns = pgTable(
  "manual_runs",
  {
    runId: uuid("run_id").primaryKey(),
    binId: text("bin_id").notNull(),
    identityId: text("identity_id").notNull(),
    sourceAdapterSnapshot: jsonb("source_adapter_snapshot").notNull(),
    sourceAdapterId: text("source_adapter_id").notNull(),
    sourceAdapterVersion: text("source_adapter_version").notNull(),
    action: text("action").notNull(),
    params: jsonb("params").notNull(),
    configSnapshot: jsonb("config_snapshot").notNull(),
    triggerType: text("trigger_type", { enum: manualRunTriggerTypes })
      .notNull()
      .default("manual"),
    // 不建立计划外键，删除计划后运行仍保留当时的触发来源。
    scheduleId: uuid("schedule_id"),
    scheduledFor: timestamp("scheduled_for", {
      withTimezone: true,
      mode: "date",
    }),
    status: text("status", { enum: manualRunStatuses }).notNull(),
    runtimeId: text("runtime_id"),
    completedScopes: jsonb("completed_scopes").notNull().default([]),
    failure: jsonb("failure"),
    output: jsonb("output"),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    stopConfirmedAt: timestamp("stop_confirmed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check("manual_runs_status_check", inArray(table.status, manualRunStatuses)),
    check(
      "manual_runs_trigger_source_check",
      or(
        and(
          eq(table.triggerType, "manual"),
          isNull(table.scheduleId),
          isNull(table.scheduledFor),
        ),
        and(
          eq(table.triggerType, "schedule"),
          isNotNull(table.scheduleId),
          isNotNull(table.scheduledFor),
        ),
      )!,
    ),
    index("manual_runs_bin_queue_idx")
      .on(table.binId, table.createdAt, table.runId)
      .where(eq(table.status, "queued")),
    uniqueIndex("manual_runs_one_executing_bin_idx")
      .on(table.binId)
      .where(inArray(table.status, ["executing", "cancelling"])),
  ],
);
