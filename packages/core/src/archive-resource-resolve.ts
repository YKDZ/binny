import {
  archiveItemStateSchema,
  archiveResourceMetadataSchema,
  archiveResourceResolveInputSchema,
  type ArchiveOperation,
  type ArchiveResourceMetadata,
  type ArchiveResourceResolveItem,
  type ArchiveResourceResolveResult,
} from "@binny/contracts";
import {
  archiveCommits,
  archiveItems,
  archiveObservations,
  archiveResources,
  archiveRevisions,
  type Database,
} from "@binny/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { failure, validationFailure } from "./archive-common.ts";
import type { ArchiveResourceStorage } from "./archive-resource-storage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Verify and resolve reusable archived resources, unchanged item states,
 * and immutable media URLs mapped by declared `extensions.media` entries.
 */
export async function resolveArchiveResources(
  database: Database,
  resourceStorage: ArchiveResourceStorage,
  rawInput: unknown,
): Promise<ArchiveOperation<ArchiveResourceResolveResult>> {
  const parsed = archiveResourceResolveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return validationFailure(
      parsed.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    );
  }

  const input = parsed.data;

  try {
    return await database.transaction(
      async (transaction) => {
        // Cache verified resources in this transaction to avoid repeated disk stat checks.
        const verifiedCache = new Map<string, ArchiveResourceMetadata | null>();

        async function verifyResource(
          resourceId: string,
        ): Promise<ArchiveResourceMetadata | null> {
          if (verifiedCache.has(resourceId)) {
            return verifiedCache.get(resourceId) ?? null;
          }

          const isAvailable = await resourceStorage.isAvailable(
            transaction,
            resourceId,
          );
          if (!isAvailable) {
            verifiedCache.set(resourceId, null);
            return null;
          }

          const rows = await transaction
            .select()
            .from(archiveResources)
            .where(
              and(
                eq(archiveResources.resourceId, resourceId),
                eq(archiveResources.status, "ready"),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (!row) {
            verifiedCache.set(resourceId, null);
            return null;
          }

          const size = Number(row.byteSize);
          if (!Number.isSafeInteger(size) || size < 0) {
            verifiedCache.set(resourceId, null);
            return null;
          }

          const parsedMeta = archiveResourceMetadataSchema.safeParse({
            resourceId: row.resourceId,
            sha256: row.sha256,
            mediaType: row.mediaType,
            size,
          });
          if (!parsedMeta.success) {
            verifiedCache.set(resourceId, null);
            return null;
          }

          verifiedCache.set(resourceId, parsedMeta.data);
          return parsedMeta.data;
        }

        // 1. Resolve requested resourceIds and sha256s.
        const requestedResources = new Map<string, ArchiveResourceMetadata>();
        const resourceConditions = [];
        if (input.resourceIds && input.resourceIds.length > 0) {
          const uniqueIds = [...new Set(input.resourceIds)];
          resourceConditions.push(
            inArray(archiveResources.resourceId, uniqueIds),
          );
        }
        if (input.sha256s && input.sha256s.length > 0) {
          const uniqueSha256s = [...new Set(input.sha256s)];
          resourceConditions.push(
            inArray(archiveResources.sha256, uniqueSha256s),
          );
        }

        if (resourceConditions.length > 0) {
          const rows = await transaction
            .select({ resourceId: archiveResources.resourceId })
            .from(archiveResources)
            .where(
              and(
                eq(archiveResources.status, "ready"),
                or(...resourceConditions),
              ),
            );

          for (const row of rows) {
            const verified = await verifyResource(row.resourceId);
            if (verified) {
              requestedResources.set(verified.resourceId, verified);
            }
          }
        }

        // 2. Resolve requested sourceKeys for (binId, sourceKey).
        const resolvedItems: ArchiveResourceResolveItem[] = [];
        if (input.sourceKeys && input.sourceKeys.length > 0) {
          const seenKeyIdentities = new Set<string>();
          for (const key of input.sourceKeys) {
            const identity = JSON.stringify([key.namespace, key.key]);
            if (seenKeyIdentities.has(identity)) continue;
            seenKeyIdentities.add(identity);

            const itemRows = await transaction
              .select({ itemId: archiveItems.itemId })
              .from(archiveItems)
              .where(
                and(
                  eq(archiveItems.namespace, key.namespace),
                  eq(archiveItems.sourceKey, key.key),
                ),
              )
              .limit(1);
            const item = itemRows[0];
            if (!item) continue;

            const obsRows = await transaction
              .select({ revisionId: archiveObservations.revisionId })
              .from(archiveObservations)
              .innerJoin(
                archiveCommits,
                eq(archiveCommits.commitId, archiveObservations.commitId),
              )
              .where(
                and(
                  eq(archiveObservations.itemId, item.itemId),
                  input.binId === undefined
                    ? undefined
                    : eq(archiveCommits.binId, input.binId),
                ),
              )
              .orderBy(
                desc(archiveCommits.archiveSequence),
                desc(archiveObservations.ordinal),
                desc(archiveCommits.commitId),
              )
              .limit(1);
            const obs = obsRows[0];
            if (!obs) continue;

            const revRows = await transaction
              .select({ stateData: archiveRevisions.stateData })
              .from(archiveRevisions)
              .where(eq(archiveRevisions.revisionId, obs.revisionId))
              .limit(1);
            const rev = revRows[0];
            if (!rev) continue;

            const parsedState = archiveItemStateSchema.safeParse(rev.stateData);
            if (!parsedState.success) continue;
            const state = parsedState.data;

            // Only return item revision if capture completeness is complete.
            if (state.capture.completeness !== "complete") continue;

            // Every referenced resource must exist with status=ready and file available on disk.
            const refIds = (state.resources ?? []).map((r) => r.resourceId);
            let allResourcesAvailable = true;
            const itemResourceMetadata: ArchiveResourceMetadata[] = [];

            for (const refId of refIds) {
              const verified = await verifyResource(refId);
              if (!verified) {
                allResourcesAvailable = false;
                break;
              }
              itemResourceMetadata.push(verified);
            }

            if (allResourcesAvailable) {
              resolvedItems.push({
                sourceKey: key,
                state,
                resourceMetadata: itemResourceMetadata,
              });
            }
          }
        }

        // 3. Resolve requested immutableMediaUrls.
        const mediaByUrl: Record<string, ArchiveResourceMetadata> = {};
        if (input.immutableMediaUrls && input.immutableMediaUrls.length > 0) {
          const urlsByNamespace = new Map<string, string[]>();
          for (const item of input.immutableMediaUrls) {
            const list = urlsByNamespace.get(item.namespace) ?? [];
            list.push(item.url);
            urlsByNamespace.set(item.namespace, list);
          }

          for (const [namespace, urls] of urlsByNamespace) {
            const uniqueUrls = [...new Set(urls)];
            const conditions = uniqueUrls.map((url) => {
              const filter = JSON.stringify([{ url }]);
              return sql`${archiveRevisions.stateData}->'extensions'->'media' @> ${filter}::text::jsonb`;
            });

            const matchingRevs = await transaction
              .select({ stateData: archiveRevisions.stateData })
              .from(archiveRevisions)
              .innerJoin(
                archiveItems,
                eq(archiveItems.itemId, archiveRevisions.itemId),
              )
              .where(
                and(eq(archiveItems.namespace, namespace), or(...conditions)),
              )
              .orderBy(desc(archiveRevisions.createdAt));

            for (const url of uniqueUrls) {
              let targetResourceId: string | undefined;

              for (const row of matchingRevs) {
                const stateData = isRecord(row.stateData)
                  ? row.stateData
                  : null;
                if (!stateData) continue;

                // Match the declared adapter media extension used by source adapters.
                const extensions = isRecord(stateData.extensions)
                  ? stateData.extensions
                  : undefined;
                const media = extensions?.media;
                if (Array.isArray(media)) {
                  for (const entry of media) {
                    if (
                      isRecord(entry) &&
                      entry.url === url &&
                      typeof entry.resourceId === "string"
                    ) {
                      targetResourceId = entry.resourceId;
                      break;
                    }
                  }
                }

                if (targetResourceId) break;
              }

              if (targetResourceId) {
                const verified = await verifyResource(targetResourceId);
                if (verified) {
                  mediaByUrl[url] = verified;
                }
              }
            }
          }
        }

        return {
          ok: true,
          value: {
            resources: [...requestedResources.values()],
            items: resolvedItems,
            mediaByUrl,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch {
    return failure(
      503,
      "resource_storage_unavailable",
      "归档资源存储暂时不可用。",
    );
  }
}
