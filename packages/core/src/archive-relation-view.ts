import {
  archiveCommits,
  archiveObservations,
  archiveRelationObservationGaps,
  archiveRelationObservations,
} from "@binny/db";
import {
  and,
  desc,
  eq,
  gt,
  lte,
  notExists,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ArchiveTransaction } from "./archive-lock.ts";

/** 关系端点资料始终按同一 bin 与 asOf 选取最后一次条目观察。 */
export function latestArchiveItemObservation(
  transaction: ArchiveTransaction,
  itemId: SQLWrapper,
  binId: SQLWrapper,
  asOf: bigint,
  aliasName: string,
) {
  const observation = alias(archiveObservations, `${aliasName}_observation`);
  const commit = alias(archiveCommits, `${aliasName}_commit`);
  return transaction
    .select({
      revisionId: observation.revisionId,
      binId: commit.binId,
      runId: commit.runId,
      sourceAdapterVersion: commit.sourceAdapterVersion,
      observedAt: commit.observedAt,
      recordedAt: commit.recordedAt,
    })
    .from(observation)
    .innerJoin(commit, eq(commit.commitId, observation.commitId))
    .where(
      and(
        eq(observation.itemId, itemId),
        eq(commit.binId, binId),
        lte(commit.archiveSequence, asOf),
      ),
    )
    .orderBy(
      desc(commit.archiveSequence),
      desc(observation.ordinal),
      desc(commit.commitId),
    )
    .limit(1)
    .as(aliasName);
}

/** 关系状态按所属 bin 的最新观察选择，撤回观察也参与排序。 */
export function latestArchiveRelationObservation(
  transaction: ArchiveTransaction,
  relationId: SQLWrapper,
  binId: SQLWrapper,
  asOf: bigint,
  aliasName: string,
) {
  const observation = alias(
    archiveRelationObservations,
    `${aliasName}_observation`,
  );
  const commit = alias(archiveCommits, `${aliasName}_commit`);
  return transaction
    .select({
      relationRevisionId: observation.relationRevisionId,
      commitId: observation.commitId,
      archiveSequence: observation.archiveSequence,
      ordinal: observation.ordinal,
      observedAt: commit.observedAt,
      recordedAt: commit.recordedAt,
      runId: commit.runId,
      sourceAdapterVersion: commit.sourceAdapterVersion,
    })
    .from(observation)
    .innerJoin(commit, eq(commit.commitId, observation.commitId))
    .where(
      and(
        eq(observation.relationId, relationId),
        eq(observation.binId, binId),
        lte(observation.archiveSequence, asOf),
      ),
    )
    .orderBy(
      desc(observation.archiveSequence),
      desc(observation.ordinal),
      desc(observation.commitId),
    )
    .limit(1)
    .as(aliasName);
}

/** 后续关系观察只覆盖同 bin 且不晚于所选 asOf 的删除缺口。 */
export function relationObservationGapIsCurrent(
  transaction: ArchiveTransaction,
  relationId: SQLWrapper,
  binId: SQLWrapper,
  gapArchiveSequence: SQLWrapper,
  asOf: bigint,
  aliasName: string,
) {
  const laterObservation = alias(archiveRelationObservations, aliasName);
  return notExists(
    transaction
      .select({ present: sql`1` })
      .from(laterObservation)
      .where(
        and(
          eq(laterObservation.relationId, relationId),
          eq(laterObservation.binId, binId),
          gt(laterObservation.archiveSequence, gapArchiveSequence),
          lte(laterObservation.archiveSequence, asOf),
        ),
      ),
  );
}

/** 取得指定 bin/asOf 下尚未被后续观察覆盖的最新关系删除缺口。 */
export function latestCurrentRelationObservationGap(
  transaction: ArchiveTransaction,
  relationId: SQLWrapper,
  binId: SQLWrapper,
  asOf: bigint,
  aliasName: string,
) {
  const gap = alias(archiveRelationObservationGaps, `${aliasName}_gap`);
  const commit = alias(archiveCommits, `${aliasName}_commit`);
  return transaction
    .select({
      relationId: gap.relationId,
      fromItemId: gap.fromItemId,
      targetItemId: gap.targetItemId,
      commitId: commit.commitId,
      archiveSequence: commit.archiveSequence,
      ordinal: gap.ordinal,
      observedAt: commit.observedAt,
      recordedAt: commit.recordedAt,
      runId: commit.runId,
      sourceAdapterVersion: commit.sourceAdapterVersion,
    })
    .from(gap)
    .innerJoin(commit, eq(commit.commitId, gap.commitId))
    .where(
      and(
        eq(gap.relationId, relationId),
        eq(commit.binId, binId),
        lte(commit.archiveSequence, asOf),
        relationObservationGapIsCurrent(
          transaction,
          gap.relationId,
          binId,
          commit.archiveSequence,
          asOf,
          `${aliasName}_later_observation`,
        ),
      ),
    )
    .orderBy(
      desc(commit.archiveSequence),
      desc(gap.ordinal),
      desc(commit.commitId),
    )
    .limit(1)
    .as(aliasName);
}
