import {
  archiveRevisionReadSchema,
  type ArchiveResourceAvailability,
  type ArchiveSearchRelatedMatch,
  type ArchiveSearchRelatedRevision,
  type SourceAdapterSearchRelation,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveItemDeletions,
  archiveItems,
  archiveObservations,
  archiveRelationObservationGaps,
  archiveRelationObservations,
  archiveRelationRevisions,
  archiveRelations,
  archiveRevisions,
  type CancellableQueryExecutor,
  type Database,
} from "@binny/db";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import {
  assertArchiveQueryActive,
  executeCancellableArchiveQuery,
} from "./archive-query-cancellation.ts";
import type { ArchiveResourceStorage } from "./archive-resource-storage.ts";

export type ArchiveSearchResourceInspector = Pick<
  ArchiveResourceStorage,
  "inspectAvailability"
>;

type SearchResultMatchInput = Readonly<Record<string, unknown>> & {
  readonly binId: string;
};

type SearchResultInput = Readonly<Record<string, unknown>> & {
  readonly itemId: string;
  readonly matches: readonly SearchResultMatchInput[];
};

type ActiveOrWithdrawnRelationRow = {
  readonly relationId: string;
  readonly binId: string;
  readonly archiveSequence: bigint | string;
  readonly ordinal: number;
  readonly commitId: string;
  readonly fromItemId: string;
  readonly targetItemId: string | null;
  readonly targetSourceRef: string | null;
  readonly relationRevisionId: string | null;
  readonly relationName: string | null;
};

type RelationGapRow = {
  readonly relationId: string;
  readonly binId: string;
  readonly archiveSequence: bigint | string;
  readonly ordinal: number;
  readonly commitId: string;
  readonly fromItemId: string;
  readonly targetItemId: string | null;
  readonly deletedNamespace: string | null;
  readonly deletedSourceKey: string | null;
  readonly itemNamespace: string | null;
  readonly itemSourceKey: string | null;
};

type RelatedItemObservationRow = {
  readonly itemId: string;
  readonly binId: string;
  readonly revisionId: string;
  readonly archiveSequence: bigint | string;
};

type ItemKeyRow = {
  readonly itemId: string;
  readonly namespace: string;
  readonly sourceKey: string;
};

type LoadedRevisionRow = {
  readonly revisionId: string;
  readonly itemId: string;
  readonly namespace: string;
  readonly sourceKey: string;
  readonly stateHash: string;
  readonly stateData: unknown;
};

type ResolvedTarget =
  | { readonly kind: "item"; readonly itemId: string }
  | { readonly kind: "sourceRef"; readonly sourceRef: string };

type GapTarget = {
  readonly counterpartItemId: string | null;
  readonly sourceKey?: { readonly namespace: string; readonly key: string };
};

function viewKey(itemId: string, binId: string): string {
  return `${itemId}\0${binId}`;
}

function relationBinKey(relationId: string, binId: string): string {
  return `${relationId}\0${binId}`;
}

function compareSequenceOrder(
  left: {
    readonly archiveSequence: bigint | string;
    readonly ordinal: number;
    readonly commitId: string;
  },
  right: {
    readonly archiveSequence: bigint | string;
    readonly ordinal: number;
    readonly commitId: string;
  },
): number {
  const leftSeq = BigInt(left.archiveSequence);
  const rightSeq = BigInt(right.archiveSequence);
  if (leftSeq !== rightSeq) return leftSeq > rightSeq ? 1 : -1;
  if (left.ordinal !== right.ordinal)
    return left.ordinal > right.ordinal ? 1 : -1;
  if (left.commitId !== right.commitId) {
    return left.commitId > right.commitId ? 1 : -1;
  }
  return 0;
}

function addToMapArray<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

async function queryLatestRelationObservations(
  database: Database,
  executeQuery: CancellableQueryExecutor,
  signal: AbortSignal | undefined,
  direction: "incoming" | "outgoing",
  itemIds: readonly string[],
  binIds: readonly string[],
  asOf: bigint,
): Promise<readonly ActiveOrWithdrawnRelationRow[]> {
  const matchedColumn =
    direction === "incoming"
      ? archiveRelations.targetItemId
      : archiveRelations.fromItemId;
  return await executeCancellableArchiveQuery<ActiveOrWithdrawnRelationRow>(
    executeQuery,
    database
      .selectDistinctOn(
        [
          archiveRelationObservations.relationId,
          archiveRelationObservations.binId,
        ],
        {
          relationId: sql`${archiveRelationObservations.relationId}`.as(
            "relationId",
          ),
          binId: sql`${archiveRelationObservations.binId}`.as("binId"),
          archiveSequence:
            sql`${archiveRelationObservations.archiveSequence}`.as(
              "archiveSequence",
            ),
          ordinal: sql`${archiveRelationObservations.ordinal}`.as("ordinal"),
          commitId: sql`${archiveRelationObservations.commitId}`.as("commitId"),
          fromItemId: sql`${archiveRelations.fromItemId}`.as("fromItemId"),
          targetItemId: sql`${archiveRelations.targetItemId}`.as(
            "targetItemId",
          ),
          targetSourceRef: sql`${archiveRelations.targetSourceRef}`.as(
            "targetSourceRef",
          ),
          relationRevisionId:
            sql`${archiveRelationObservations.relationRevisionId}`.as(
              "relationRevisionId",
            ),
          relationName: sql`${archiveRelationRevisions.stateData}->>'name'`.as(
            "relationName",
          ),
        },
      )
      .from(archiveRelationObservations)
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
          inArray(matchedColumn, itemIds),
          inArray(archiveRelationObservations.binId, binIds),
          lte(archiveRelationObservations.archiveSequence, asOf),
        ),
      )
      .orderBy(
        asc(archiveRelationObservations.relationId),
        asc(archiveRelationObservations.binId),
        desc(archiveRelationObservations.archiveSequence),
        desc(archiveRelationObservations.ordinal),
        desc(archiveRelationObservations.commitId),
      ),
    signal,
  );
}

async function queryLatestRelationGaps(
  database: Database,
  executeQuery: CancellableQueryExecutor,
  signal: AbortSignal | undefined,
  direction: "incoming" | "outgoing",
  itemIds: readonly string[],
  binIds: readonly string[],
  asOf: bigint,
): Promise<readonly RelationGapRow[]> {
  const matchedColumn =
    direction === "incoming"
      ? archiveRelationObservationGaps.targetItemId
      : archiveRelationObservationGaps.fromItemId;
  const counterpartColumn =
    direction === "incoming"
      ? archiveRelationObservationGaps.fromItemId
      : archiveRelationObservationGaps.targetItemId;
  return await executeCancellableArchiveQuery<RelationGapRow>(
    executeQuery,
    database
      .selectDistinctOn(
        [archiveRelationObservationGaps.relationId, archiveCommits.binId],
        {
          relationId: sql`${archiveRelationObservationGaps.relationId}`.as(
            "relationId",
          ),
          binId: sql`${archiveCommits.binId}`.as("binId"),
          archiveSequence: sql`${archiveCommits.archiveSequence}`.as(
            "archiveSequence",
          ),
          ordinal: sql`${archiveRelationObservationGaps.ordinal}`.as("ordinal"),
          commitId: sql`${archiveCommits.commitId}`.as("commitId"),
          fromItemId: sql`${archiveRelationObservationGaps.fromItemId}`.as(
            "fromItemId",
          ),
          targetItemId: sql`${archiveRelationObservationGaps.targetItemId}`.as(
            "targetItemId",
          ),
          deletedNamespace: sql`${archiveItemDeletions.namespace}`.as(
            "deletedNamespace",
          ),
          deletedSourceKey: sql`${archiveItemDeletions.sourceKey}`.as(
            "deletedSourceKey",
          ),
          itemNamespace: sql`${archiveItems.namespace}`.as("itemNamespace"),
          itemSourceKey: sql`${archiveItems.sourceKey}`.as("itemSourceKey"),
        },
      )
      .from(archiveRelationObservationGaps)
      .innerJoin(
        archiveCommits,
        eq(archiveCommits.commitId, archiveRelationObservationGaps.commitId),
      )
      .leftJoin(
        archiveItemDeletions,
        eq(archiveItemDeletions.itemId, counterpartColumn),
      )
      .leftJoin(archiveItems, eq(archiveItems.itemId, counterpartColumn))
      .where(
        and(
          inArray(matchedColumn, itemIds),
          inArray(archiveCommits.binId, binIds),
          lte(archiveCommits.archiveSequence, asOf),
        ),
      )
      .orderBy(
        asc(archiveRelationObservationGaps.relationId),
        asc(archiveCommits.binId),
        desc(archiveCommits.archiveSequence),
        desc(archiveRelationObservationGaps.ordinal),
        desc(archiveCommits.commitId),
      ),
    signal,
  );
}

/**
 * Resolve adapter-declared related item revisions for every matched view on
 * the current search page at the fixed snapshot cut `asOf`, deduplicating
 * readable revisions by `revisionId` across the page.
 */
export async function resolveSearchRelatedItems(input: {
  readonly database: Database;
  readonly executeQuery: CancellableQueryExecutor;
  readonly resourceStorage: ArchiveSearchResourceInspector;
  readonly signal: AbortSignal | undefined;
  readonly asOf: bigint;
  readonly requestedRelations: ReadonlyMap<string, SourceAdapterSearchRelation>;
  readonly results: readonly SearchResultInput[];
}): Promise<{
  readonly results: readonly SearchResultInput[];
  readonly relatedRevisions: Record<string, ArchiveSearchRelatedRevision>;
}> {
  const {
    database,
    executeQuery,
    resourceStorage,
    signal,
    asOf,
    requestedRelations,
    results,
  } = input;

  if (results.length === 0) {
    return { results, relatedRevisions: {} };
  }

  const matchedItemIds = [...new Set(results.map((result) => result.itemId))];
  const matchedBinIds = [
    ...new Set(
      results.flatMap((result) => result.matches.map((match) => match.binId)),
    ),
  ];
  const directions = [
    ...new Set(
      [...requestedRelations.values()].map(
        (declaration) => declaration.direction,
      ),
    ),
  ];

  // Key: `${matchedItemId}\0${binId}\0${relationName}\0${direction}` -> targets
  const activeTargetsByRoleScope = new Map<string, ResolvedTarget[]>();
  const latestObsByDirection = new Map<
    "incoming" | "outgoing",
    Map<string, ActiveOrWithdrawnRelationRow>
  >();
  const gapRowsByDirection = new Map<
    "incoming" | "outgoing",
    readonly RelationGapRow[]
  >();

  for (const direction of directions) {
    assertArchiveQueryActive(signal);
    const observations = await queryLatestRelationObservations(
      database,
      executeQuery,
      signal,
      direction,
      matchedItemIds,
      matchedBinIds,
      asOf,
    );
    const obsMap = new Map<string, ActiveOrWithdrawnRelationRow>();
    for (const row of observations) {
      obsMap.set(relationBinKey(row.relationId, row.binId), row);
    }
    latestObsByDirection.set(direction, obsMap);

    const gaps = await queryLatestRelationGaps(
      database,
      executeQuery,
      signal,
      direction,
      matchedItemIds,
      matchedBinIds,
      asOf,
    );
    gapRowsByDirection.set(direction, gaps);

    const latestGapByRelationBin = new Map<string, RelationGapRow>();
    for (const gap of gaps) {
      latestGapByRelationBin.set(
        relationBinKey(gap.relationId, gap.binId),
        gap,
      );
    }

    for (const row of observations) {
      if (row.relationRevisionId === null || row.relationName === null) {
        continue;
      }
      const gap = latestGapByRelationBin.get(
        relationBinKey(row.relationId, row.binId),
      );
      if (gap !== undefined && compareSequenceOrder(gap, row) > 0) {
        continue;
      }
      const matchedItemId =
        direction === "incoming" ? row.targetItemId : row.fromItemId;
      if (matchedItemId === null) continue;

      const target: ResolvedTarget | undefined =
        direction === "incoming"
          ? { kind: "item", itemId: row.fromItemId }
          : row.targetItemId !== null
            ? { kind: "item", itemId: row.targetItemId }
            : row.targetSourceRef !== null
              ? { kind: "sourceRef", sourceRef: row.targetSourceRef }
              : undefined;
      if (target === undefined) continue;

      const scopeKey = `${matchedItemId}\0${row.binId}\0${row.relationName}\0${direction}`;
      addToMapArray(activeTargetsByRoleScope, scopeKey, target);
    }
  }

  // Key: `${matchedItemId}\0${binId}\0${direction}` -> GapTarget[]
  const gapsByViewDirection = new Map<string, GapTarget[]>();
  for (const direction of directions) {
    const obsMap = latestObsByDirection.get(direction) ?? new Map();
    const gaps = gapRowsByDirection.get(direction) ?? [];
    for (const gap of gaps) {
      const obs = obsMap.get(relationBinKey(gap.relationId, gap.binId));
      if (obs !== undefined && compareSequenceOrder(obs, gap) > 0) {
        continue;
      }
      const matchedItemId =
        direction === "incoming" ? gap.targetItemId : gap.fromItemId;
      if (matchedItemId === null) continue;
      const counterpartItemId =
        direction === "incoming" ? gap.fromItemId : gap.targetItemId;
      const namespace = gap.deletedNamespace ?? gap.itemNamespace;
      const key = gap.deletedSourceKey ?? gap.itemSourceKey;
      addToMapArray(
        gapsByViewDirection,
        `${matchedItemId}\0${gap.binId}\0${direction}`,
        {
          counterpartItemId,
          ...(namespace !== null && key !== null
            ? { sourceKey: { namespace, key } }
            : {}),
        },
      );
    }
  }

  // First pass over page matches: identify single internal target itemIds to resolve.
  const singleTargetItemIds = new Set<string>();
  const singleTargetViews: {
    readonly itemId: string;
    readonly binId: string;
    readonly role: string;
    readonly relatedItemId: string;
  }[] = [];

  type PreliminaryRoleStatus =
    | { readonly kind: "pending_item"; readonly relatedItemId: string }
    | { readonly kind: "resolved"; readonly value: ArchiveSearchRelatedMatch };

  const preliminaryByViewRole = new Map<string, PreliminaryRoleStatus>();

  for (const result of results) {
    for (const match of result.matches) {
      for (const [role, declaration] of requestedRelations) {
        const roleViewKey = `${result.itemId}\0${match.binId}\0${role}`;
        const scopeKey = `${result.itemId}\0${match.binId}\0${declaration.relationName}\0${declaration.direction}`;
        const targets = activeTargetsByRoleScope.get(scopeKey) ?? [];
        if (targets.length > 0) {
          const uniqueTargets = new Map<string, ResolvedTarget>();
          for (const target of targets) {
            const targetKey =
              target.kind === "item"
                ? `item:${target.itemId}`
                : `sourceRef:${target.sourceRef}`;
            uniqueTargets.set(targetKey, target);
          }
          if (uniqueTargets.size > 1) {
            preliminaryByViewRole.set(roleViewKey, {
              kind: "resolved",
              value: { status: "unreadable", reason: "ambiguous_target" },
            });
            continue;
          }
          const [onlyTarget] = uniqueTargets.values();
          if (onlyTarget === undefined) {
            preliminaryByViewRole.set(roleViewKey, {
              kind: "resolved",
              value: { status: "none" },
            });
            continue;
          }
          if (onlyTarget.kind === "sourceRef") {
            preliminaryByViewRole.set(roleViewKey, {
              kind: "resolved",
              value: {
                status: "unreadable",
                reason: "external_target",
                sourceRef: onlyTarget.sourceRef,
              },
            });
            continue;
          }
          singleTargetItemIds.add(onlyTarget.itemId);
          singleTargetViews.push({
            itemId: result.itemId,
            binId: match.binId,
            role,
            relatedItemId: onlyTarget.itemId,
          });
          preliminaryByViewRole.set(roleViewKey, {
            kind: "pending_item",
            relatedItemId: onlyTarget.itemId,
          });
          continue;
        }

        const gaps =
          gapsByViewDirection.get(
            `${result.itemId}\0${match.binId}\0${declaration.direction}`,
          ) ?? [];
        if (gaps.length === 0) {
          preliminaryByViewRole.set(roleViewKey, {
            kind: "resolved",
            value: { status: "none" },
          });
          continue;
        }
        const uniqueGapTargets = new Map<string, GapTarget>();
        for (const gapTarget of gaps) {
          const gapKey = gapTarget.counterpartItemId ?? "external";
          if (!uniqueGapTargets.has(gapKey)) {
            uniqueGapTargets.set(gapKey, gapTarget);
          }
        }
        if (uniqueGapTargets.size > 1) {
          preliminaryByViewRole.set(roleViewKey, {
            kind: "resolved",
            value: { status: "unreadable", reason: "ambiguous_target" },
          });
          continue;
        }
        const [onlyGap] = uniqueGapTargets.values();
        preliminaryByViewRole.set(roleViewKey, {
          kind: "resolved",
          value: {
            status: "unreadable",
            reason: "deleted",
            ...(onlyGap?.counterpartItemId !== null &&
            onlyGap?.counterpartItemId !== undefined
              ? { itemId: onlyGap.counterpartItemId }
              : {}),
            ...(onlyGap?.sourceKey === undefined
              ? {}
              : { sourceKey: onlyGap.sourceKey }),
          },
        });
      }
    }
  }

  // Step C: Resolve latest item observations in the same bin at <= asOf.
  const latestRelatedObservations = new Map<
    string,
    RelatedItemObservationRow
  >();
  if (singleTargetItemIds.size > 0) {
    assertArchiveQueryActive(signal);
    const observationRows =
      await executeCancellableArchiveQuery<RelatedItemObservationRow>(
        executeQuery,
        database
          .selectDistinctOn(
            [archiveObservations.itemId, archiveCommits.binId],
            {
              itemId: sql`${archiveObservations.itemId}`.as("itemId"),
              binId: sql`${archiveCommits.binId}`.as("binId"),
              revisionId: sql`${archiveObservations.revisionId}`.as(
                "revisionId",
              ),
              archiveSequence: sql`${archiveCommits.archiveSequence}`.as(
                "archiveSequence",
              ),
            },
          )
          .from(archiveObservations)
          .innerJoin(
            archiveCommits,
            eq(archiveCommits.commitId, archiveObservations.commitId),
          )
          .where(
            and(
              inArray(archiveObservations.itemId, [...singleTargetItemIds]),
              inArray(archiveCommits.binId, matchedBinIds),
              lte(archiveCommits.archiveSequence, asOf),
            ),
          )
          .orderBy(
            asc(archiveObservations.itemId),
            asc(archiveCommits.binId),
            desc(archiveCommits.archiveSequence),
            desc(archiveObservations.ordinal),
            desc(archiveCommits.commitId),
          ),
        signal,
      );
    for (const row of observationRows) {
      latestRelatedObservations.set(viewKey(row.itemId, row.binId), row);
    }
  }

  // Resolve metadata for any target items unobserved in the matched bin at <= asOf.
  const unobservedTargetItemIds = new Set<string>();
  const provisionalReadableRevisions = new Set<string>();
  for (const target of singleTargetViews) {
    const obs = latestRelatedObservations.get(
      viewKey(target.relatedItemId, target.binId),
    );
    if (obs === undefined) {
      unobservedTargetItemIds.add(target.relatedItemId);
    } else {
      provisionalReadableRevisions.add(obs.revisionId);
    }
  }

  const itemKeys = new Map<
    string,
    { readonly namespace: string; readonly key: string }
  >();
  const deletedItemKeys = new Map<
    string,
    { readonly namespace: string; readonly key: string }
  >();
  if (unobservedTargetItemIds.size > 0) {
    assertArchiveQueryActive(signal);
    const targetIdList = [...unobservedTargetItemIds];
    const [existingRows, deletedRows] = await Promise.all([
      executeCancellableArchiveQuery<ItemKeyRow>(
        executeQuery,
        database
          .select({
            itemId: sql`${archiveItems.itemId}`.as("itemId"),
            namespace: sql`${archiveItems.namespace}`.as("namespace"),
            sourceKey: sql`${archiveItems.sourceKey}`.as("sourceKey"),
          })
          .from(archiveItems)
          .where(inArray(archiveItems.itemId, targetIdList)),
        signal,
      ),
      executeCancellableArchiveQuery<ItemKeyRow>(
        executeQuery,
        database
          .select({
            itemId: sql`${archiveItemDeletions.itemId}`.as("itemId"),
            namespace: sql`${archiveItemDeletions.namespace}`.as("namespace"),
            sourceKey: sql`${archiveItemDeletions.sourceKey}`.as("sourceKey"),
          })
          .from(archiveItemDeletions)
          .where(inArray(archiveItemDeletions.itemId, targetIdList)),
        signal,
      ),
    ]);
    for (const row of existingRows) {
      itemKeys.set(row.itemId, {
        namespace: row.namespace,
        key: row.sourceKey,
      });
    }
    for (const row of deletedRows) {
      deletedItemKeys.set(row.itemId, {
        namespace: row.namespace,
        key: row.sourceKey,
      });
    }
  }

  // Step E: Batch load deduplicated readable revisions & physical resource availability.
  const relatedRevisions: Record<string, ArchiveSearchRelatedRevision> = {};
  if (provisionalReadableRevisions.size > 0) {
    assertArchiveQueryActive(signal);
    const revisionRows =
      await executeCancellableArchiveQuery<LoadedRevisionRow>(
        executeQuery,
        database
          .select({
            revisionId: sql`${archiveRevisions.revisionId}`.as("revisionId"),
            itemId: sql`${archiveRevisions.itemId}`.as("itemId"),
            namespace: sql`${archiveItems.namespace}`.as("namespace"),
            sourceKey: sql`${archiveItems.sourceKey}`.as("sourceKey"),
            stateHash: sql`${archiveRevisions.stateHash}`.as("stateHash"),
            stateData: sql`${archiveRevisions.stateData}`.as("stateData"),
          })
          .from(archiveRevisions)
          .innerJoin(
            archiveItems,
            eq(archiveItems.itemId, archiveRevisions.itemId),
          )
          .where(
            inArray(archiveRevisions.revisionId, [
              ...provisionalReadableRevisions,
            ]),
          ),
        signal,
      );

    const parsedRevisions = revisionRows.map((row) =>
      archiveRevisionReadSchema.parse({
        revisionId: row.revisionId,
        itemId: row.itemId,
        sourceKey: { namespace: row.namespace, key: row.sourceKey },
        stateHash: row.stateHash,
        state: row.stateData,
      }),
    );

    const allResourceIds = [
      ...new Set(
        parsedRevisions.flatMap((revision) =>
          (revision.state.resources ?? []).map(({ resourceId }) => resourceId),
        ),
      ),
    ];
    const resourceAvailability =
      allResourceIds.length === 0
        ? new Map<string, boolean>()
        : await resourceStorage.inspectAvailability(
            allResourceIds,
            executeQuery,
            signal,
          );

    for (const revision of parsedRevisions) {
      const resources: ArchiveResourceAvailability[] = (
        revision.state.resources ?? []
      ).map(({ resourceId }) => ({
        resourceId,
        status:
          resourceAvailability.get(resourceId.toLowerCase()) === true
            ? ("available" as const)
            : ("missing" as const),
      }));
      relatedRevisions[revision.revisionId] = {
        revision,
        resources,
      };
    }
  }

  const enrichedResults = results.map((result) => ({
    ...result,
    matches: result.matches.map((match) => {
      const related: Record<string, ArchiveSearchRelatedMatch> = {};
      for (const role of requestedRelations.keys()) {
        const preliminary = preliminaryByViewRole.get(
          `${result.itemId}\0${match.binId}\0${role}`,
        );
        if (preliminary === undefined) {
          related[role] = { status: "none" };
          continue;
        }
        if (preliminary.kind === "resolved") {
          related[role] = preliminary.value;
          continue;
        }
        const obs = latestRelatedObservations.get(
          viewKey(preliminary.relatedItemId, match.binId),
        );
        if (obs === undefined) {
          const deletedKey = deletedItemKeys.get(preliminary.relatedItemId);
          if (deletedKey !== undefined) {
            related[role] = {
              status: "unreadable",
              reason: "deleted",
              itemId: preliminary.relatedItemId,
              sourceKey: deletedKey,
            };
          } else {
            const knownKey = itemKeys.get(preliminary.relatedItemId);
            related[role] = {
              status: "unreadable",
              reason: "not_observed",
              itemId: preliminary.relatedItemId,
              ...(knownKey === undefined ? {} : { sourceKey: knownKey }),
            };
          }
          continue;
        }
        if (!Object.hasOwn(relatedRevisions, obs.revisionId)) {
          // Revision disappeared concurrently between snapshot read and batch fetch.
          related[role] = {
            status: "unreadable",
            reason: "deleted",
            itemId: preliminary.relatedItemId,
          };
          continue;
        }
        related[role] = {
          status: "readable",
          reference: {
            itemId: preliminary.relatedItemId,
            binId: match.binId,
            revisionId: obs.revisionId,
            archiveSeq: BigInt(obs.archiveSequence).toString(),
          },
        };
      }
      return {
        ...match,
        related,
      };
    }),
  }));

  return {
    results: enrichedResults,
    relatedRevisions,
  };
}
