import {
  archiveCommitSchema,
  archiveIdentifierSchema,
  archiveItemReadSchema,
  archiveRelationCursorSchema,
  archiveRelationEntrySchema,
  archiveRelationPageSchema,
  archiveRelationStateSchema,
  archiveRevisionReadSchema,
  archiveSnapshotSequenceSchema,
  archiveTimelineCursorSchema,
  archiveTimelinePageSchema,
  binIdSchema,
  type ArchiveCommit,
  type ArchiveItemRead,
  type ArchiveOperation,
  type ArchiveOperations,
  type ArchiveRelationEntry,
  type ArchiveRelationOptions,
} from "@binny/contracts";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lte,
  min,
  notExists,
  or,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";

import {
  failure,
  isoTimestamp,
  optionalText,
  validationFailure,
} from "./archive-common.ts";
import type { ArchiveTransaction } from "./archive-lock.ts";
import type { CoreDatabase } from "./database.ts";
import {
  archiveCommits,
  archiveItemDeletions,
  archiveItemObservationGaps,
  archiveItems,
  archiveObservations,
  archiveRelationObservationGaps,
  archiveRelationObservations,
  archiveRelationRevisions,
  archiveRelations,
  archiveRevisions,
  archiveWriteClock,
} from "./schema.ts";

export type ResolvedSnapshot = {
  readonly asOf: string;
  readonly mode: "current" | "asOf";
};

/**
 * 读取调用者须先用 repeatable read、read only 配置事务；本函数在该快照中读取写时钟。
 */
export async function resolveSnapshot(
  transaction: ArchiveTransaction,
  requestedAsOf?: string,
): Promise<ArchiveOperation<ResolvedSnapshot>> {
  const clocks = await transaction
    .select({ lastSequence: archiveWriteClock.lastSequence })
    .from(archiveWriteClock)
    .where(eq(archiveWriteClock.clockId, 1))
    .limit(1);
  const currentSequence = clocks[0]?.lastSequence;
  if (currentSequence === undefined) {
    throw new Error("归档写入时钟尚未初始化。");
  }
  const currentSequenceText = currentSequence.toString();
  const checkedAsOf =
    requestedAsOf === undefined
      ? undefined
      : archiveSnapshotSequenceSchema.safeParse(requestedAsOf);
  if (checkedAsOf !== undefined && !checkedAsOf.success) {
    return validationFailure(
      checkedAsOf.error.issues.map((issue) => ({
        message: issue.message,
        path: ["asOf", ...issue.path],
      })),
    );
  }
  const asOf = checkedAsOf?.data ?? currentSequenceText;
  if (BigInt(asOf) > currentSequence) {
    return failure(400, "invalid_input", "归档截点不能晚于当前已记录的资料。", [
      "asOf",
    ]);
  }
  return {
    ok: true,
    value: {
      asOf,
      mode: requestedAsOf === undefined ? "current" : "asOf",
    },
  };
}

function encodeTimelineCursor(
  cursor: ReturnType<typeof archiveTimelineCursorSchema.parse>,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeTimelineCursor(
  cursor: string,
): ReturnType<typeof archiveTimelineCursorSchema.parse> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    return archiveTimelineCursorSchema.parse(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

function encodeRelationCursor(
  cursor: ReturnType<typeof archiveRelationCursorSchema.parse>,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeRelationCursor(
  cursor: string,
): ReturnType<typeof archiveRelationCursorSchema.parse> | undefined {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json).toString("base64url") !== cursor) return undefined;
    return archiveRelationCursorSchema.parse(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

function optionalDiagnostics(value: unknown): {
  readonly diagnostics?: unknown;
} {
  return value === null ? {} : { diagnostics: value };
}

function nullableColumn<TColumn extends AnyColumn>(
  column: TColumn,
  aliasName: string,
) {
  // UNION 分支会以 NULL 补齐该列；保留原列解码器并显式标记可空性。
  return sql`${column}`.mapWith(column).nullable().as(aliasName);
}

function nullColumn<TColumn extends AnyColumn>(
  decoder: TColumn,
  aliasName: string,
) {
  // RC 没有无表空值选择器；此处只生成 UNION 所需的 NULL 列，并沿用目标列解码器。
  return sql`NULL`.mapWith(decoder).nullable().as(aliasName);
}

function textLiteral(value: string) {
  // UNION／CTE 沿用左分支 decoder；所有文本标记共用实际文本列 decoder，公开结果由契约解析。
  return sql`${value}::text`.mapWith(archiveCommits.binId);
}

function withArchiveReadTransaction<T>(
  database: CoreDatabase,
  operation: (transaction: ArchiveTransaction) => Promise<T>,
): Promise<T> {
  return database.transaction(operation, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function readCommit(
  transaction: ArchiveTransaction,
  commitId: string,
): Promise<ArchiveCommit> {
  const commitRows = await transaction
    .select({
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
    })
    .from(archiveCommits)
    .where(eq(archiveCommits.commitId, commitId))
    .limit(1);
  const commit = commitRows[0];
  if (commit === undefined) {
    throw new Error("幂等回执引用的归档提交不存在。");
  }

  const items = await transaction
    .select({
      itemId: archiveObservations.itemId,
      revisionId: archiveObservations.revisionId,
      namespace: archiveItems.namespace,
      sourceKey: archiveItems.sourceKey,
    })
    .from(archiveObservations)
    .innerJoin(
      archiveItems,
      eq(archiveItems.itemId, archiveObservations.itemId),
    )
    .where(eq(archiveObservations.commitId, commitId))
    .orderBy(asc(archiveObservations.ordinal));
  const relations = await transaction
    .select({
      relationId: archiveRelationObservations.relationId,
      ordinal: archiveRelationObservations.ordinal,
      relationRevisionId: archiveRelationObservations.relationRevisionId,
      stateData: archiveRelationRevisions.stateData,
    })
    .from(archiveRelationObservations)
    .leftJoin(
      archiveRelationRevisions,
      and(
        eq(
          archiveRelationRevisions.relationId,
          archiveRelationObservations.relationId,
        ),
        eq(
          archiveRelationRevisions.relationRevisionId,
          archiveRelationObservations.relationRevisionId,
        ),
      ),
    )
    .where(eq(archiveRelationObservations.commitId, commitId))
    .orderBy(asc(archiveRelationObservations.ordinal));
  const itemGaps = await transaction
    .select({
      itemId: archiveItemObservationGaps.itemId,
      ordinal: archiveItemObservationGaps.ordinal,
      namespace: archiveItemDeletions.namespace,
      sourceKey: archiveItemDeletions.sourceKey,
    })
    .from(archiveItemObservationGaps)
    .innerJoin(
      archiveItemDeletions,
      eq(archiveItemDeletions.itemId, archiveItemObservationGaps.itemId),
    )
    .where(eq(archiveItemObservationGaps.commitId, commitId))
    .orderBy(asc(archiveItemObservationGaps.ordinal));
  const relationGaps = await transaction
    .select({
      relationId: archiveRelationObservationGaps.relationId,
      ordinal: archiveRelationObservationGaps.ordinal,
    })
    .from(archiveRelationObservationGaps)
    .where(eq(archiveRelationObservationGaps.commitId, commitId))
    .orderBy(asc(archiveRelationObservationGaps.ordinal));

  return archiveCommitSchema.parse({
    commitId: commit.commitId,
    archiveSeq: commit.archiveSequence.toString(),
    binId: commit.binId,
    ...optionalText("runId", commit.runId),
    ...optionalText("collectorVersion", commit.collectorVersion),
    observedAt: isoTimestamp(commit.observedAt),
    recordedAt: isoTimestamp(commit.recordedAt),
    items: items.map((item) => ({
      itemId: item.itemId,
      revisionId: item.revisionId,
      sourceKey: { namespace: item.namespace, key: item.sourceKey },
    })),
    relations: relations.map((relation) =>
      relation.relationRevisionId === null
        ? {
            relationId: relation.relationId,
            ordinal: relation.ordinal,
            status: "withdrawn" as const,
          }
        : {
            relationId: relation.relationId,
            ordinal: relation.ordinal,
            status: "observed" as const,
            revisionId: relation.relationRevisionId,
            state: relation.stateData,
          },
    ),
    ...(itemGaps.length === 0 && relationGaps.length === 0
      ? {}
      : {
          gaps: {
            items: itemGaps.map((item) => ({
              itemId: item.itemId,
              ordinal: item.ordinal,
              sourceKey: { namespace: item.namespace, key: item.sourceKey },
            })),
            relations: relationGaps.map((relation) => ({
              relationId: relation.relationId,
              ordinal: relation.ordinal,
            })),
          },
        }),
  });
}

async function readItem(
  transaction: ArchiveTransaction,
  itemId: string,
  snapshot: ResolvedSnapshot,
  binId?: string,
): Promise<ArchiveOperation<ArchiveItemRead>> {
  const items = await transaction
    .select({
      itemId: archiveItems.itemId,
      namespace: archiveItems.namespace,
      sourceKey: archiveItems.sourceKey,
    })
    .from(archiveItems)
    .where(eq(archiveItems.itemId, itemId))
    .limit(1);
  const item = items[0];
  if (item === undefined) {
    const deletions = await transaction
      .select({ itemId: archiveItemDeletions.itemId })
      .from(archiveItemDeletions)
      .where(eq(archiveItemDeletions.itemId, itemId))
      .limit(1);
    if (deletions[0] !== undefined) {
      return failure(
        404,
        "item_deleted",
        "这个条目已硬删除；历史只保留删除缺口，原资料不再可读。",
        ["itemId"],
      );
    }
    return failure(404, "item_not_found", "没有找到这个归档条目。", ["itemId"]);
  }

  const asOf = BigInt(snapshot.asOf);
  const visibleRows = await transaction
    .select({ itemId: archiveObservations.itemId })
    .from(archiveObservations)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveObservations.commitId),
    )
    .where(
      and(
        eq(archiveObservations.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
      ),
    )
    .limit(1);
  if (visibleRows[0] === undefined) {
    return failure(404, "item_not_found", "这个条目在所选归档截点尚未记录。", [
      "itemId",
    ]);
  }

  const revisionRows = await transaction
    .select({
      revisionId: archiveRevisions.revisionId,
      stateHash: archiveRevisions.stateHash,
      firstArchiveSequence: min(archiveCommits.archiveSequence),
    })
    .from(archiveRevisions)
    .innerJoin(
      archiveObservations,
      and(
        eq(archiveObservations.itemId, archiveRevisions.itemId),
        eq(archiveObservations.revisionId, archiveRevisions.revisionId),
      ),
    )
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveObservations.commitId),
    )
    .where(
      and(
        eq(archiveObservations.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    )
    .groupBy(archiveRevisions.revisionId, archiveRevisions.stateHash)
    .orderBy(
      min(archiveCommits.archiveSequence),
      asc(archiveRevisions.revisionId),
    );

  // Drizzle RC 没有 JSON 文本提取构建器；这里只保留单个投影表达式。
  const sourceModifiedAt =
    sql`${archiveRevisions.stateData}->>'sourceModifiedAt'`
      .mapWith(archiveCommits.binId)
      .nullable()
      .as("sourceModifiedAt");
  const observationRows = await transaction
    .select({
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      revisionId: archiveObservations.revisionId,
      diagnostics: archiveObservations.diagnostics,
      ordinal: archiveObservations.ordinal,
      sourceModifiedAt,
    })
    .from(archiveObservations)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveObservations.commitId),
    )
    .innerJoin(
      archiveRevisions,
      and(
        eq(archiveRevisions.itemId, archiveObservations.itemId),
        eq(archiveRevisions.revisionId, archiveObservations.revisionId),
      ),
    )
    .where(
      and(
        eq(archiveObservations.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    )
    .orderBy(
      asc(archiveCommits.archiveSequence),
      asc(archiveObservations.ordinal),
      asc(archiveCommits.commitId),
    );

  const viewRows = await transaction
    .selectDistinctOn([archiveCommits.binId], {
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      revisionId: archiveObservations.revisionId,
      diagnostics: archiveObservations.diagnostics,
      stateData: archiveRevisions.stateData,
    })
    .from(archiveObservations)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveObservations.commitId),
    )
    .innerJoin(
      archiveRevisions,
      and(
        eq(archiveRevisions.itemId, archiveObservations.itemId),
        eq(archiveRevisions.revisionId, archiveObservations.revisionId),
      ),
    )
    .where(
      and(
        eq(archiveObservations.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    )
    .orderBy(
      asc(archiveCommits.binId),
      desc(archiveCommits.archiveSequence),
      desc(archiveObservations.ordinal),
      desc(archiveCommits.commitId),
    );

  return {
    ok: true,
    value: archiveItemReadSchema.parse({
      itemId: item.itemId,
      sourceKey: { namespace: item.namespace, key: item.sourceKey },
      snapshot,
      views: viewRows.map((row) => ({
        binId: row.binId,
        archiveSeq: row.archiveSequence.toString(),
        revisionId: row.revisionId,
        observedAt: isoTimestamp(row.observedAt),
        recordedAt: isoTimestamp(row.recordedAt),
        ...optionalText("runId", row.runId),
        ...optionalText("collectorVersion", row.collectorVersion),
        state: row.stateData,
        ...optionalDiagnostics(row.diagnostics),
      })),
      revisions: revisionRows.map((revision) => ({
        revisionId: revision.revisionId,
        stateHash: revision.stateHash,
      })),
      observations: observationRows.map((row) => ({
        commitId: row.commitId,
        archiveSeq: row.archiveSequence.toString(),
        ordinal: row.ordinal,
        binId: row.binId,
        revisionId: row.revisionId,
        ...(row.sourceModifiedAt === null
          ? {}
          : { sourceModifiedAt: row.sourceModifiedAt }),
        observedAt: isoTimestamp(row.observedAt),
        recordedAt: isoTimestamp(row.recordedAt),
        ...optionalText("runId", row.runId),
        ...optionalText("collectorVersion", row.collectorVersion),
        ...optionalDiagnostics(row.diagnostics),
      })),
    }),
  };
}

async function readTimelinePage(
  transaction: ArchiveTransaction,
  itemId: string,
  snapshot: ResolvedSnapshot,
  binId: string | undefined,
  after:
    | ReturnType<typeof archiveTimelineCursorSchema.parse>["after"]
    | undefined,
  limit: number,
): Promise<
  ArchiveOperation<ReturnType<typeof archiveTimelinePageSchema.parse>>
> {
  const asOf = BigInt(snapshot.asOf);
  const visible = or(
    exists(
      transaction
        .select({ itemId: archiveObservations.itemId })
        .from(archiveObservations)
        .innerJoin(
          archiveCommits,
          eq(archiveCommits.commitId, archiveObservations.commitId),
        )
        .where(
          and(
            eq(archiveObservations.itemId, itemId),
            lte(archiveCommits.archiveSequence, asOf),
          ),
        ),
    ),
    exists(
      transaction
        .select({ relationId: archiveRelations.relationId })
        .from(archiveRelationObservations)
        .innerJoin(
          archiveRelations,
          eq(
            archiveRelations.relationId,
            archiveRelationObservations.relationId,
          ),
        )
        .where(
          and(
            or(
              eq(archiveRelations.fromItemId, itemId),
              eq(archiveRelations.targetItemId, itemId),
            ),
            lte(archiveRelationObservations.archiveSequence, asOf),
          ),
        ),
    ),
    exists(
      transaction
        .select({ itemId: archiveItemObservationGaps.itemId })
        .from(archiveItemObservationGaps)
        .innerJoin(
          archiveCommits,
          eq(archiveCommits.commitId, archiveItemObservationGaps.commitId),
        )
        .where(
          and(
            eq(archiveItemObservationGaps.itemId, itemId),
            lte(archiveCommits.archiveSequence, asOf),
          ),
        ),
    ),
    exists(
      transaction
        .select({ relationId: archiveRelationObservationGaps.relationId })
        .from(archiveRelationObservationGaps)
        .innerJoin(
          archiveCommits,
          eq(archiveCommits.commitId, archiveRelationObservationGaps.commitId),
        )
        .where(
          and(
            or(
              eq(archiveRelationObservationGaps.fromItemId, itemId),
              eq(archiveRelationObservationGaps.targetItemId, itemId),
            ),
            lte(archiveCommits.archiveSequence, asOf),
          ),
        ),
    ),
  );
  const visibleRows = await transaction
    .select({ clockId: archiveWriteClock.clockId })
    .from(archiveWriteClock)
    .where(visible)
    .limit(1);
  if (visibleRows[0] === undefined) {
    return failure(404, "item_not_found", "这个条目在所选归档截点尚未记录。", [
      "itemId",
    ]);
  }

  const itemEvents = transaction
    .select({
      kind: textLiteral("item").as("kind"),
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      itemId: nullableColumn(archiveObservations.itemId, "itemId"),
      relationId: nullColumn(archiveRelations.relationId, "relationId"),
      relationRevisionId: nullColumn(
        archiveRelationObservations.relationRevisionId,
        "relationRevisionId",
      ),
      relationStateData: nullColumn(
        archiveRelationRevisions.stateData,
        "relationStateData",
      ),
      revisionId: nullableColumn(archiveObservations.revisionId, "revisionId"),
      ordinal: archiveObservations.ordinal,
      // RC 没有 JSON 文本提取构建器；只对来源时间字段保留局部运算符。
      sourceModifiedAt: sql`${archiveRevisions.stateData}->>'sourceModifiedAt'`
        .mapWith(archiveCommits.binId)
        .nullable()
        .as("sourceModifiedAt"),
      gapSubjectKind: nullColumn(
        archiveRelationObservationGaps.relationId,
        "gapSubjectKind",
      ),
      gapNamespace: nullColumn(archiveItems.namespace, "gapNamespace"),
      gapSourceKey: nullColumn(archiveItems.sourceKey, "gapSourceKey"),
    })
    .from(archiveObservations)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveObservations.commitId),
    )
    .innerJoin(
      archiveRevisions,
      and(
        eq(archiveRevisions.itemId, archiveObservations.itemId),
        eq(archiveRevisions.revisionId, archiveObservations.revisionId),
      ),
    )
    .where(
      and(
        eq(archiveObservations.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    );

  const relationEvents = transaction
    .select({
      kind: textLiteral("relation").as("kind"),
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      itemId: nullColumn(archiveItems.itemId, "itemId"),
      relationId: nullableColumn(
        archiveRelationObservations.relationId,
        "relationId",
      ),
      relationRevisionId: nullableColumn(
        archiveRelationObservations.relationRevisionId,
        "relationRevisionId",
      ),
      relationStateData: nullableColumn(
        archiveRelationRevisions.stateData,
        "relationStateData",
      ),
      revisionId: nullableColumn(
        archiveRelationObservations.relationRevisionId,
        "revisionId",
      ),
      ordinal: archiveRelationObservations.ordinal,
      sourceModifiedAt: nullColumn(archiveCommits.binId, "sourceModifiedAt"),
      gapSubjectKind: nullColumn(
        archiveRelationObservationGaps.relationId,
        "gapSubjectKind",
      ),
      gapNamespace: nullColumn(archiveItems.namespace, "gapNamespace"),
      gapSourceKey: nullColumn(archiveItems.sourceKey, "gapSourceKey"),
    })
    .from(archiveRelationObservations)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveRelationObservations.commitId),
    )
    .innerJoin(
      archiveRelations,
      eq(archiveRelations.relationId, archiveRelationObservations.relationId),
    )
    .leftJoin(
      archiveRelationRevisions,
      and(
        eq(
          archiveRelationRevisions.relationId,
          archiveRelationObservations.relationId,
        ),
        eq(
          archiveRelationRevisions.relationRevisionId,
          archiveRelationObservations.relationRevisionId,
        ),
      ),
    )
    .where(
      and(
        or(
          eq(archiveRelations.fromItemId, itemId),
          eq(archiveRelations.targetItemId, itemId),
        ),
        lte(archiveRelationObservations.archiveSequence, asOf),
        binId === undefined
          ? undefined
          : eq(archiveRelationObservations.binId, binId),
      ),
    );

  const itemGapEvents = transaction
    .select({
      kind: textLiteral("gap").as("kind"),
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      itemId: nullableColumn(archiveItemObservationGaps.itemId, "itemId"),
      relationId: nullColumn(archiveRelations.relationId, "relationId"),
      relationRevisionId: nullColumn(
        archiveRelationObservations.relationRevisionId,
        "relationRevisionId",
      ),
      relationStateData: nullColumn(
        archiveRelationRevisions.stateData,
        "relationStateData",
      ),
      revisionId: nullColumn(archiveObservations.revisionId, "revisionId"),
      ordinal: archiveItemObservationGaps.ordinal,
      sourceModifiedAt: nullColumn(archiveCommits.binId, "sourceModifiedAt"),
      gapSubjectKind: textLiteral("item").as("gapSubjectKind"),
      gapNamespace: nullableColumn(
        archiveItemDeletions.namespace,
        "gapNamespace",
      ),
      gapSourceKey: nullableColumn(
        archiveItemDeletions.sourceKey,
        "gapSourceKey",
      ),
    })
    .from(archiveItemObservationGaps)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveItemObservationGaps.commitId),
    )
    .innerJoin(
      archiveItemDeletions,
      eq(archiveItemDeletions.itemId, archiveItemObservationGaps.itemId),
    )
    .where(
      and(
        eq(archiveItemObservationGaps.itemId, itemId),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    );

  const relationGapEvents = transaction
    .select({
      kind: textLiteral("gap").as("kind"),
      commitId: archiveCommits.commitId,
      archiveSequence: archiveCommits.archiveSequence,
      binId: archiveCommits.binId,
      runId: archiveCommits.runId,
      collectorVersion: archiveCommits.collectorVersion,
      observedAt: archiveCommits.observedAt,
      recordedAt: archiveCommits.recordedAt,
      itemId: nullColumn(archiveItems.itemId, "itemId"),
      relationId: nullableColumn(
        archiveRelationObservationGaps.relationId,
        "relationId",
      ),
      relationRevisionId: nullColumn(
        archiveRelationObservations.relationRevisionId,
        "relationRevisionId",
      ),
      relationStateData: nullColumn(
        archiveRelationRevisions.stateData,
        "relationStateData",
      ),
      revisionId: nullColumn(archiveObservations.revisionId, "revisionId"),
      ordinal: archiveRelationObservationGaps.ordinal,
      sourceModifiedAt: nullColumn(archiveCommits.binId, "sourceModifiedAt"),
      gapSubjectKind: textLiteral("relation").as("gapSubjectKind"),
      gapNamespace: nullColumn(archiveItems.namespace, "gapNamespace"),
      gapSourceKey: nullColumn(archiveItems.sourceKey, "gapSourceKey"),
    })
    .from(archiveRelationObservationGaps)
    .innerJoin(
      archiveCommits,
      eq(archiveCommits.commitId, archiveRelationObservationGaps.commitId),
    )
    .where(
      and(
        or(
          eq(archiveRelationObservationGaps.fromItemId, itemId),
          eq(archiveRelationObservationGaps.targetItemId, itemId),
        ),
        lte(archiveCommits.archiveSequence, asOf),
        binId === undefined ? undefined : eq(archiveCommits.binId, binId),
      ),
    );

  const events = transaction
    .$with("timeline_events")
    .as(unionAll(itemEvents, relationEvents, itemGapEvents, relationGapEvents));
  const afterCursor =
    after === undefined
      ? undefined
      : or(
          gt(events.archiveSequence, BigInt(after.archiveSeq)),
          and(
            eq(events.archiveSequence, BigInt(after.archiveSeq)),
            gt(events.ordinal, after.ordinal),
          ),
          and(
            eq(events.archiveSequence, BigInt(after.archiveSeq)),
            eq(events.ordinal, after.ordinal),
            gt(events.commitId, after.commitId),
          ),
        );
  const rows = await transaction
    .with(events)
    .select()
    .from(events)
    .where(afterCursor)
    .orderBy(
      asc(events.archiveSequence),
      asc(events.ordinal),
      asc(events.commitId),
    )
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeTimelineCursor({
          version: 1,
          itemId,
          binId: binId ?? null,
          snapshot: { asOf: snapshot.asOf, mode: "asOf" },
          after: {
            archiveSeq: last.archiveSequence.toString(),
            ordinal: last.ordinal,
            commitId: last.commitId,
          },
        })
      : undefined;

  return {
    ok: true,
    value: archiveTimelinePageSchema.parse({
      itemId,
      snapshot,
      events: pageRows.map((row) => {
        const metadata = {
          commitId: row.commitId,
          archiveSeq: row.archiveSequence.toString(),
          ordinal: row.ordinal,
          binId: row.binId,
          ...optionalText("runId", row.runId),
          ...optionalText("collectorVersion", row.collectorVersion),
          observedAt: isoTimestamp(row.observedAt),
          recordedAt: isoTimestamp(row.recordedAt),
        };
        if (row.kind === "item") {
          if (row.itemId === null || row.revisionId === null) {
            throw new Error("条目时间线事件缺少条目或内容版本。");
          }
          return {
            ...metadata,
            kind: "item" as const,
            itemId: row.itemId,
            revisionId: row.revisionId,
            ...(row.sourceModifiedAt === null
              ? {}
              : { sourceModifiedAt: row.sourceModifiedAt }),
          };
        }
        if (row.kind === "gap") {
          if (row.gapSubjectKind === "item") {
            if (
              row.itemId === null ||
              row.gapNamespace === null ||
              row.gapSourceKey === null
            ) {
              throw new Error("条目删除缺口缺少来源身份。");
            }
            return {
              ...metadata,
              kind: "gap" as const,
              subject: {
                kind: "item" as const,
                itemId: row.itemId,
                sourceKey: {
                  namespace: row.gapNamespace,
                  key: row.gapSourceKey,
                },
              },
            };
          }
          if (row.gapSubjectKind !== "relation" || row.relationId === null) {
            throw new Error("关系删除缺口缺少关系身份。");
          }
          return {
            ...metadata,
            kind: "gap" as const,
            subject: {
              kind: "relation" as const,
              relationId: row.relationId,
            },
          };
        }
        if (row.kind !== "relation" || row.relationId === null) {
          throw new Error("关系时间线事件缺少关系身份。");
        }
        if (row.relationRevisionId === null) {
          return {
            ...metadata,
            kind: "relation" as const,
            relationId: row.relationId,
            status: "withdrawn" as const,
          };
        }
        if (row.relationStateData === null) {
          throw new Error("已观察关系缺少不可变关系版本。");
        }
        return {
          ...metadata,
          kind: "relation" as const,
          relationId: row.relationId,
          status: "observed" as const,
          revisionId: row.relationRevisionId,
          state: row.relationStateData,
        };
      }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

async function readRelationsPage(
  transaction: ArchiveTransaction,
  itemId: string,
  binId: string,
  direction: ArchiveRelationOptions["direction"],
  snapshot: ResolvedSnapshot,
  after: string | undefined,
  limit: number,
): Promise<
  ArchiveOperation<ReturnType<typeof archiveRelationPageSchema.parse>>
> {
  const asOf = BigInt(snapshot.asOf);
  const gap = alias(archiveRelationObservationGaps, "gap");
  const gapCommit = alias(archiveCommits, "gap_commit");
  const laterObservation = alias(
    archiveRelationObservations,
    "later_observation",
  );
  const latestObservation = alias(
    archiveRelationObservations,
    "latest_observation",
  );
  const latestCommit = alias(archiveCommits, "latest_commit");
  const latest = transaction
    .select({
      commitId: latestObservation.commitId,
      archiveSequence: latestObservation.archiveSequence,
      ordinal: latestObservation.ordinal,
      relationRevisionId: latestObservation.relationRevisionId,
      observedAt: latestCommit.observedAt,
      recordedAt: latestCommit.recordedAt,
      runId: latestCommit.runId,
      collectorVersion: latestCommit.collectorVersion,
    })
    .from(latestObservation)
    .innerJoin(
      latestCommit,
      eq(latestCommit.commitId, latestObservation.commitId),
    )
    .where(
      and(
        eq(latestObservation.relationId, archiveRelations.relationId),
        eq(latestObservation.binId, binId),
        lte(latestObservation.archiveSequence, asOf),
      ),
    )
    .orderBy(
      desc(latestObservation.archiveSequence),
      desc(latestObservation.ordinal),
      desc(latestObservation.commitId),
    )
    .limit(1)
    .as("latest_relation_observation");

  const laterObservations = transaction
    .select({ relationId: laterObservation.relationId })
    .from(laterObservation)
    .where(
      and(
        eq(laterObservation.relationId, gap.relationId),
        eq(laterObservation.binId, binId),
        gt(laterObservation.archiveSequence, gapCommit.archiveSequence),
        lte(laterObservation.archiveSequence, asOf),
      ),
    );
  const currentGaps = transaction
    .select({ relationId: gap.relationId })
    .from(gap)
    .innerJoin(gapCommit, eq(gapCommit.commitId, gap.commitId))
    .where(
      and(
        eq(gap.relationId, archiveRelations.relationId),
        eq(gapCommit.binId, binId),
        lte(gapCommit.archiveSequence, asOf),
        notExists(laterObservations),
      ),
    );

  const gapRows = transaction
    .selectDistinctOn([gap.relationId], {
      kind: textLiteral("deleted").as("kind"),
      relationId: gap.relationId,
      fromItemId: nullableColumn(gap.fromItemId, "fromItemId"),
      targetItemId: nullableColumn(gap.targetItemId, "targetItemId"),
      targetSourceRef: nullColumn(
        archiveRelations.targetSourceRef,
        "targetSourceRef",
      ),
      relationRevisionId: nullColumn(
        archiveRelationObservations.relationRevisionId,
        "relationRevisionId",
      ),
      stateData: nullColumn(archiveRelationRevisions.stateData, "stateData"),
      relationCommitId: nullableColumn(gapCommit.commitId, "relationCommitId"),
      // UNION CTE 的可空 lateral bigint 类型在此 RC 无法推导；转为 text 并用实际文本解码器保留精度。
      relationArchiveSequence: sql`${gapCommit.archiveSequence}::text`
        .mapWith(archiveCommits.binId)
        .nullable()
        .as("relationArchiveSequence"),
      relationOrdinal: nullableColumn(gap.ordinal, "relationOrdinal"),
      relationObservedAt: nullableColumn(
        gapCommit.observedAt,
        "relationObservedAt",
      ),
      relationRecordedAt: nullableColumn(
        gapCommit.recordedAt,
        "relationRecordedAt",
      ),
      relationRunId: nullableColumn(gapCommit.runId, "relationRunId"),
      relationCollectorVersion: nullableColumn(
        gapCommit.collectorVersion,
        "relationCollectorVersion",
      ),
    })
    .from(gap)
    .innerJoin(gapCommit, eq(gapCommit.commitId, gap.commitId))
    .where(
      and(
        direction === "outgoing"
          ? eq(gap.fromItemId, itemId)
          : eq(gap.targetItemId, itemId),
        eq(gapCommit.binId, binId),
        lte(gapCommit.archiveSequence, asOf),
        notExists(laterObservations),
      ),
    )
    .orderBy(
      gap.relationId,
      desc(gapCommit.archiveSequence),
      desc(gap.ordinal),
      desc(gap.commitId),
    );

  const activeRows = transaction
    .select({
      kind: textLiteral("active").as("kind"),
      relationId: archiveRelations.relationId,
      fromItemId: nullableColumn(archiveRelations.fromItemId, "fromItemId"),
      targetItemId: nullableColumn(
        archiveRelations.targetItemId,
        "targetItemId",
      ),
      targetSourceRef: nullableColumn(
        archiveRelations.targetSourceRef,
        "targetSourceRef",
      ),
      relationRevisionId: nullableColumn(
        latest.relationRevisionId,
        "relationRevisionId",
      ),
      stateData: nullableColumn(
        archiveRelationRevisions.stateData,
        "stateData",
      ),
      relationCommitId: nullableColumn(latest.commitId, "relationCommitId"),
      // 与删除缺口分支使用相同的精确十进制序号表示。
      relationArchiveSequence: sql`${latest.archiveSequence}::text`
        .mapWith(archiveCommits.binId)
        .nullable()
        .as("relationArchiveSequence"),
      relationOrdinal: nullableColumn(latest.ordinal, "relationOrdinal"),
      relationObservedAt: nullableColumn(
        latest.observedAt,
        "relationObservedAt",
      ),
      relationRecordedAt: nullableColumn(
        latest.recordedAt,
        "relationRecordedAt",
      ),
      relationRunId: nullableColumn(latest.runId, "relationRunId"),
      relationCollectorVersion: nullableColumn(
        latest.collectorVersion,
        "relationCollectorVersion",
      ),
    })
    .from(archiveRelations)
    // RC 的 lateral join 要求显式 on 表达式；true 表示保留子查询的单行或空结果。
    .leftJoinLateral(latest, sql`true`)
    .leftJoin(
      archiveRelationRevisions,
      and(
        eq(archiveRelationRevisions.relationId, archiveRelations.relationId),
        eq(
          archiveRelationRevisions.relationRevisionId,
          latest.relationRevisionId,
        ),
      ),
    )
    .where(
      and(
        direction === "outgoing"
          ? eq(archiveRelations.fromItemId, itemId)
          : eq(archiveRelations.targetItemId, itemId),
        lte(archiveRelations.createdSequence, asOf),
        notExists(currentGaps),
      ),
    );

  const candidates = transaction
    .$with("relation_candidates")
    .as(unionAll(activeRows, gapRows));
  const rows = await transaction
    .with(candidates)
    .select()
    .from(candidates)
    .where(after === undefined ? undefined : gt(candidates.relationId, after))
    .orderBy(asc(candidates.relationId))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeRelationCursor({
          version: 1,
          itemId,
          binId,
          direction,
          snapshot: { asOf: snapshot.asOf, mode: "asOf" },
          after: { relationId: last.relationId },
        })
      : undefined;

  const endpointIds = [
    ...new Set(
      pageRows.flatMap((row) => {
        if (row.kind === "deleted") return [];
        if (row.fromItemId === null) {
          throw new Error("关系来源端点缺少身份。");
        }
        return row.targetItemId === null
          ? [row.fromItemId]
          : [row.fromItemId, row.targetItemId];
      }),
    ),
  ];
  const latestItemObservation = alias(
    archiveObservations,
    "latest_item_observation",
  );
  const latestItemCommit = alias(archiveCommits, "latest_item_commit");
  const latestItem = transaction
    .select({ revisionId: latestItemObservation.revisionId })
    .from(latestItemObservation)
    .innerJoin(
      latestItemCommit,
      eq(latestItemCommit.commitId, latestItemObservation.commitId),
    )
    .where(
      and(
        eq(latestItemObservation.itemId, archiveItems.itemId),
        eq(latestItemCommit.binId, binId),
        lte(latestItemCommit.archiveSequence, asOf),
      ),
    )
    .orderBy(
      desc(latestItemCommit.archiveSequence),
      desc(latestItemObservation.ordinal),
      desc(latestItemCommit.commitId),
    )
    .limit(1)
    .as("latest_item_view");
  const endpointRows =
    endpointIds.length === 0
      ? []
      : await transaction
          .select({
            itemId: archiveItems.itemId,
            namespace: archiveItems.namespace,
            sourceKey: archiveItems.sourceKey,
            revisionId: latestItem.revisionId,
          })
          .from(archiveItems)
          .leftJoinLateral(latestItem, sql`true`)
          .where(inArray(archiveItems.itemId, endpointIds));
  const endpoints = new Map(
    endpointRows.map((row) => [row.itemId, row] as const),
  );

  const relations: ArchiveRelationEntry[] = pageRows.map((row) => {
    const stateStatus =
      row.kind === "deleted"
        ? "deleted"
        : row.relationCommitId === null
          ? "unknown"
          : row.relationRevisionId === null
            ? "withdrawn"
            : "observed";
    const relationObservation = () => {
      const relationCommitId = row.relationCommitId;
      const relationArchiveSequence = row.relationArchiveSequence;
      const relationOrdinal = row.relationOrdinal;
      const relationObservedAt = row.relationObservedAt;
      const relationRecordedAt = row.relationRecordedAt;
      if (
        relationCommitId === null ||
        relationArchiveSequence === null ||
        relationOrdinal === null ||
        relationObservedAt === null ||
        relationRecordedAt === null
      ) {
        throw new Error("关系观察缺少提交溯源信息。");
      }
      return {
        commitId: relationCommitId,
        archiveSeq: relationArchiveSequence,
        ordinal: relationOrdinal,
        observedAt: isoTimestamp(relationObservedAt),
        recordedAt: isoTimestamp(relationRecordedAt),
        ...optionalText("runId", row.relationRunId),
        ...optionalText("collectorVersion", row.relationCollectorVersion),
      };
    };
    if (stateStatus === "deleted") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relationId,
        status: "deleted",
        observation: relationObservation(),
      });
    }
    const fromItemId = row.fromItemId;
    if (fromItemId === null) {
      throw new Error("关系来源端点在读取期间消失。");
    }
    const fromRow = endpoints.get(fromItemId);
    if (fromRow === undefined) {
      throw new Error("关系来源端点在读取期间消失。");
    }
    const endpoint = (item: typeof fromRow) => ({
      kind: "item" as const,
      itemId: item.itemId,
      sourceKey: { namespace: item.namespace, key: item.sourceKey },
      status:
        item.revisionId === null ? ("unknown" as const) : ("observed" as const),
      ...(item.revisionId === null ? {} : { revisionId: item.revisionId }),
    });
    const targetItemId = row.targetItemId;
    const targetSourceRef = row.targetSourceRef;
    const to =
      targetItemId === null
        ? targetSourceRef === null
          ? (() => {
              throw new Error("关系目标缺少条目或来源引用。");
            })()
          : {
              kind: "sourceRef" as const,
              sourceRef: targetSourceRef,
            }
        : (() => {
            const targetRow = endpoints.get(targetItemId);
            if (targetRow === undefined) {
              throw new Error("关系目标端点在读取期间消失。");
            }
            return endpoint(targetRow);
          })();
    if (stateStatus === "unknown") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relationId,
        status: stateStatus,
        from: endpoint(fromRow),
        to,
      });
    }
    if (stateStatus === "withdrawn") {
      return archiveRelationEntrySchema.parse({
        relationId: row.relationId,
        status: stateStatus,
        from: endpoint(fromRow),
        to,
        observation: relationObservation(),
      });
    }
    const revisionId = row.relationRevisionId;
    const stateData = row.stateData;
    if (revisionId === null || stateData === null) {
      throw new Error("已观察关系缺少不可变关系版本。");
    }
    return archiveRelationEntrySchema.parse({
      relationId: row.relationId,
      status: "observed",
      from: endpoint(fromRow),
      to,
      revisionId,
      state: archiveRelationStateSchema.parse(stateData),
      observation: relationObservation(),
    });
  });

  return {
    ok: true,
    value: archiveRelationPageSchema.parse({
      itemId,
      binId,
      direction,
      snapshot,
      relations,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }),
  };
}

export function createArchiveReadOperations(
  database: CoreDatabase,
): Pick<
  ArchiveOperations,
  | "getArchiveItem"
  | "getArchiveRelations"
  | "getArchiveRevision"
  | "getArchiveTimeline"
  | "getArchiveCommit"
> {
  return {
    async getArchiveItem(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId =
        options?.binId === undefined
          ? undefined
          : binIdSchema.safeParse(options.binId);
      if (checkedBinId !== undefined && !checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      return await withArchiveReadTransaction(database, async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, options?.asOf);
        if (!snapshot.ok) return snapshot;
        return await readItem(
          transaction,
          checkedId.data,
          snapshot.value,
          checkedBinId?.data,
        );
      });
    },

    async getArchiveRelations(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId = binIdSchema.safeParse(options.binId);
      if (!checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return failure(400, "invalid_input", "关系每页必须读取 1 到 100 项。", [
          "limit",
        ]);
      }

      const cursor =
        options.cursor === undefined
          ? undefined
          : decodeRelationCursor(options.cursor);
      if (options.cursor !== undefined && cursor === undefined) {
        return failure(400, "invalid_input", "关系游标格式无效。", ["cursor"]);
      }
      if (cursor !== undefined && cursor.itemId !== checkedId.data) {
        return failure(400, "invalid_input", "关系游标不属于这个条目。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        (cursor.binId !== checkedBinId.data ||
          cursor.direction !== options.direction)
      ) {
        return failure(400, "invalid_input", "关系游标的来源或方向不匹配。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        options.asOf !== undefined &&
        options.asOf !== cursor.snapshot.asOf
      ) {
        return failure(400, "invalid_input", "关系游标的归档截点不匹配。", [
          "asOf",
        ]);
      }

      const requestedAsOf = cursor?.snapshot.asOf ?? options.asOf;
      return await withArchiveReadTransaction(database, async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, requestedAsOf);
        if (!snapshot.ok) return snapshot;
        const items = await transaction
          .select({ itemId: archiveItems.itemId })
          .from(archiveItems)
          .where(eq(archiveItems.itemId, checkedId.data))
          .unionAll(
            transaction
              .select({ itemId: archiveItemDeletions.itemId })
              .from(archiveItemDeletions)
              .where(eq(archiveItemDeletions.itemId, checkedId.data)),
          )
          .limit(1);
        if (items[0] === undefined) {
          return failure(404, "item_not_found", "没有找到这个归档条目。", [
            "itemId",
          ]);
        }
        return await readRelationsPage(
          transaction,
          checkedId.data,
          checkedBinId.data,
          options.direction,
          snapshot.value,
          cursor?.after.relationId,
          limit,
        );
      });
    },

    async getArchiveRevision(revisionId) {
      const checkedId = archiveIdentifierSchema.safeParse(revisionId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["revisionId", ...issue.path],
          })),
        );
      }
      return await withArchiveReadTransaction(database, async (transaction) => {
        const rows = await transaction
          .select({
            revisionId: archiveRevisions.revisionId,
            stateHash: archiveRevisions.stateHash,
            stateData: archiveRevisions.stateData,
            itemId: archiveItems.itemId,
            namespace: archiveItems.namespace,
            sourceKey: archiveItems.sourceKey,
          })
          .from(archiveRevisions)
          .innerJoin(
            archiveItems,
            eq(archiveItems.itemId, archiveRevisions.itemId),
          )
          .where(eq(archiveRevisions.revisionId, checkedId.data))
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          return failure(404, "revision_not_found", "没有找到这个内容版本。", [
            "revisionId",
          ]);
        }
        return {
          ok: true,
          value: archiveRevisionReadSchema.parse({
            revisionId: row.revisionId,
            itemId: row.itemId,
            sourceKey: { namespace: row.namespace, key: row.sourceKey },
            stateHash: row.stateHash,
            state: row.stateData,
          }),
        };
      });
    },

    async getArchiveTimeline(itemId, options) {
      const checkedId = archiveIdentifierSchema.safeParse(itemId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["itemId", ...issue.path],
          })),
        );
      }
      const checkedBinId =
        options?.binId === undefined
          ? undefined
          : binIdSchema.safeParse(options.binId);
      if (checkedBinId !== undefined && !checkedBinId.success) {
        return validationFailure(
          checkedBinId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["binId", ...issue.path],
          })),
        );
      }
      const limit = options?.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return failure(
          400,
          "invalid_input",
          "时间线每页必须读取 1 到 100 条观察。",
          ["limit"],
        );
      }

      const cursor =
        options?.cursor === undefined
          ? undefined
          : decodeTimelineCursor(options.cursor);
      if (options?.cursor !== undefined && cursor === undefined) {
        return failure(400, "invalid_input", "时间线游标格式无效。", [
          "cursor",
        ]);
      }
      if (cursor !== undefined && cursor.itemId !== checkedId.data) {
        return failure(400, "invalid_input", "时间线游标不属于这个条目。", [
          "cursor",
        ]);
      }
      if (
        cursor !== undefined &&
        checkedBinId?.data !== undefined &&
        checkedBinId.data !== (cursor.binId ?? undefined)
      ) {
        return failure(400, "invalid_input", "时间线游标的来源范围不匹配。", [
          "binId",
        ]);
      }
      if (
        cursor !== undefined &&
        options?.asOf !== undefined &&
        options.asOf !== cursor.snapshot.asOf
      ) {
        return failure(400, "invalid_input", "时间线游标的归档截点不匹配。", [
          "asOf",
        ]);
      }

      const binId = cursor?.binId ?? checkedBinId?.data;
      const requestedAsOf = cursor?.snapshot.asOf ?? options?.asOf;
      return await withArchiveReadTransaction(database, async (transaction) => {
        const snapshot = await resolveSnapshot(transaction, requestedAsOf);
        if (!snapshot.ok) return snapshot;
        if (
          cursor !== undefined &&
          BigInt(cursor.after.archiveSeq) > BigInt(snapshot.value.asOf)
        ) {
          return failure(400, "invalid_input", "时间线游标超出归档截点。", [
            "cursor",
          ]);
        }
        return await readTimelinePage(
          transaction,
          checkedId.data,
          snapshot.value,
          binId,
          cursor?.after,
          limit,
        );
      });
    },

    async getArchiveCommit(commitId) {
      const checkedId = archiveIdentifierSchema.safeParse(commitId);
      if (!checkedId.success) {
        return validationFailure(
          checkedId.error.issues.map((issue) => ({
            message: issue.message,
            path: ["commitId", ...issue.path],
          })),
        );
      }
      return await withArchiveReadTransaction(database, async (transaction) => {
        const rows = await transaction
          .select({ commitId: archiveCommits.commitId })
          .from(archiveCommits)
          .where(eq(archiveCommits.commitId, checkedId.data))
          .limit(1);
        if (rows[0] === undefined) {
          return failure(404, "commit_not_found", "没有找到这个归档提交。", [
            "commitId",
          ]);
        }
        return {
          ok: true,
          value: await readCommit(transaction, checkedId.data),
        };
      });
    },
  };
}
