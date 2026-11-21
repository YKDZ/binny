// Shared incremental synchronization state schemas and management helpers.
import { createHash } from "node:crypto";

import { manualRunAbortCauseSchema } from "@binny/contracts";
import { z } from "zod";

import {
  sourceAdapterActionError,
  type SourceAdapterContext,
} from "./index.ts";

export const incrementalBodyGapRecordSchema = z
  .object({
    url: z.string().min(1),
    stage: z.enum(["fetching-article", "extracting-article"]),
    code: z.string().min(1),
    reason: z.string().min(1),
    httpStatus: z.number().int().min(100).max(599).optional(),
    abortCause: manualRunAbortCauseSchema.optional(),
  })
  .strict();

export type IncrementalBodyGapRecord = z.infer<
  typeof incrementalBodyGapRecordSchema
>;

export const incrementalEntryRecordSchema = z
  .object({
    /** Latest observed index fingerprint (updated on baseline, archive, or body gap). */
    fingerprint: z.string().min(1),
    updatedAt: z.string().optional(),
    publishedAt: z.string().optional(),
    /** Canonical article URL observed in the feed, used to align explicit URL backfill with feed state. */
    articleUrl: z.string().min(1).optional(),
    /**
     * Actual archive state:
     * - "baseline": initial sync index baseline without archiving;
     * - "complete" | "partial": successfully archived ("partial" indicates missing secondary media only);
     * - undefined: never successfully archived (e.g. body fetch or extraction failed on discovery).
     */
    archivedCompleteness: z
      .enum(["baseline", "partial", "complete"])
      .optional(),
    /** Index fingerprint of the most recent successful archive submission. */
    archivedFingerprint: z.string().min(1).optional(),
    /** Unresolved article body fetch/extraction gap for the current observed fingerprint. */
    bodyGap: incrementalBodyGapRecordSchema.optional(),
  })
  .strict();

export type IncrementalEntryRecord = z.infer<
  typeof incrementalEntryRecordSchema
>;

export const feedBodyGapSchema = z
  .object({
    scope: z
      .string()
      .min(1)
      .describe("Source scope identifier where the item was discovered."),
    itemKey: z
      .string()
      .min(1)
      .describe("Stable source item key from the feed."),
    url: z.url().describe("Article URL whose body could not be archived."),
    stage: z.enum(["fetching-article", "extracting-article"]),
    code: z.enum([
      "article_fetch_failed",
      "article_http_error",
      "article_extraction_failed",
      "article_content_empty",
    ]),
    reason: z.string().min(1).describe("Factual reason for the body failure."),
    httpStatus: z.number().int().min(100).max(599).optional(),
    abortCause: manualRunAbortCauseSchema.optional(),
  })
  .strict();

export type FeedBodyGap = z.infer<typeof feedBodyGapSchema>;

export const feedIncompleteScopeSchema = z
  .object({
    scope: z.string().min(1),
    reasonCode: z.enum(["article_body_unavailable", "max_items_reached"]),
    message: z.string().min(1),
  })
  .strict();

export type FeedIncompleteScope = z.infer<typeof feedIncompleteScopeSchema>;

export const feedSyncOutputSchema = z
  .object({
    collectionCompleteness: z.enum(["complete", "partial"]),
    completedScopes: z.array(z.string().min(1)),
    initializedScopes: z.array(z.string().min(1)).optional(),
    incompleteScopes: z.array(feedIncompleteScopeSchema).optional(),
    bodyGaps: z.array(feedBodyGapSchema).optional(),
  })
  .strict();

export type FeedSyncOutput = z.infer<typeof feedSyncOutputSchema>;

export const incrementalOngoingDocumentRecordSchema = z
  .object({
    contentHash: z.string().min(1),
    updatedAt: z.string().optional(),
  })
  .strict();

export type IncrementalOngoingDocumentRecord = z.infer<
  typeof incrementalOngoingDocumentRecordSchema
>;

export const incrementalScopeStateSchema = z
  .object({
    scopeUrl: z.string().optional(),
    initializedAt: z.string().min(1),
    etag: z.string().optional(),
    lastModified: z.string().optional(),
    entries: z.record(z.string(), incrementalEntryRecordSchema).default({}),
    ongoingDocuments: z
      .record(z.string(), incrementalOngoingDocumentRecordSchema)
      .optional(),
  })
  .strict();

export type IncrementalScopeState = z.infer<typeof incrementalScopeStateSchema>;

export const incrementalSyncStateSchema = z
  .object({
    version: z.literal(1),
    scopes: z.record(z.string(), incrementalScopeStateSchema),
  })
  .strict();

export type IncrementalSyncState = z.infer<typeof incrementalSyncStateSchema>;

export function createEmptyIncrementalSyncState(): IncrementalSyncState {
  return {
    version: 1,
    scopes: {},
  };
}

/** Loads and validates incremental sync state from context.persistentState; returns empty state if not initialized. */
export async function loadIncrementalSyncState(
  context: SourceAdapterContext,
): Promise<IncrementalSyncState> {
  if (context.persistentState === undefined) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: "当前运行器未提供信源适配器持久状态。",
      impact: "本次同步已停止，未读取或更新状态。",
      requiresHuman: false,
    });
  }
  let saved: unknown;
  try {
    saved = await context.persistentState.load();
  } catch (error) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: `无法读取信源适配器持久状态：${error instanceof Error ? error.message : String(error)}`,
      impact: "本次同步已停止，未读取或更新状态。",
      requiresHuman: true,
    });
  }
  if (saved === undefined) {
    return createEmptyIncrementalSyncState();
  }
  const parsed = incrementalSyncStateSchema.safeParse(saved);
  if (!parsed.success) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: "信源适配器持久状态不符合声明的格式规范。",
      impact: "本次同步已停止，未重置或推进任何范围。",
      requiresHuman: true,
    });
  }
  return parsed.data;
}

/** Validates and saves incremental sync state to context.persistentState. */
export async function saveIncrementalSyncState(
  context: SourceAdapterContext,
  state: IncrementalSyncState,
): Promise<void> {
  if (context.persistentState === undefined) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: "当前运行器未提供信源适配器持久状态。",
      impact: "本次同步已停止，状态未持久保存。",
      requiresHuman: false,
    });
  }
  const parsed = incrementalSyncStateSchema.safeParse(state);
  if (!parsed.success) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: "要保存的信源适配器持久状态格式无效。",
      impact: "本次同步已停止，状态未持久保存。",
      requiresHuman: false,
    });
  }
  try {
    await context.persistentState.save(parsed.data);
  } catch (error) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: `无法保存信源适配器持久状态：${error instanceof Error ? error.message : String(error)}`,
      impact: "本次同步已停止，状态未持久保存。",
      requiresHuman: true,
    });
  }
}

/** Checks whether a target scope is initialized and optional scope URL matches. */
export function isIncrementalScopeInitialized(
  state: IncrementalSyncState,
  scopeId: string,
  expectedScopeUrl?: string,
): boolean {
  const scope = state.scopes[scopeId];
  if (scope === undefined || scope.initializedAt === undefined) {
    return false;
  }
  if (expectedScopeUrl !== undefined && scope.scopeUrl !== expectedScopeUrl) {
    return false;
  }
  return true;
}

/** Establishes a scope baseline on initial sync, recording entry identities and fingerprints without archiving. */
export function initializeIncrementalScope(
  state: IncrementalSyncState,
  scopeId: string,
  options: {
    readonly scopeUrl?: string | undefined;
    readonly initializedAt: string;
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
    readonly entries?: Record<string, IncrementalEntryRecord> | undefined;
    readonly ongoingDocuments?:
      | Record<string, IncrementalOngoingDocumentRecord>
      | undefined;
  },
): IncrementalScopeState {
  const scope: IncrementalScopeState = {
    initializedAt: options.initializedAt,
    ...(options.scopeUrl === undefined ? {} : { scopeUrl: options.scopeUrl }),
    ...(options.etag === undefined ? {} : { etag: options.etag }),
    ...(options.lastModified === undefined
      ? {}
      : { lastModified: options.lastModified }),
    entries: { ...options.entries },
    ...(options.ongoingDocuments === undefined
      ? {}
      : { ongoingDocuments: { ...options.ongoingDocuments } }),
  };
  state.scopes[scopeId] = scope;
  return scope;
}

/** Determines whether an entry in an initialized scope is new or modified. */
export function hasIncrementalEntryChanged(
  previousEntry: IncrementalEntryRecord | undefined,
  currentFingerprint: string,
  currentUpdatedAt?: string,
): boolean {
  if (previousEntry === undefined) {
    return true;
  }
  if (previousEntry.fingerprint !== currentFingerprint) {
    return true;
  }
  if (
    currentUpdatedAt !== undefined &&
    previousEntry.updatedAt !== undefined &&
    previousEntry.updatedAt !== currentUpdatedAt
  ) {
    return true;
  }
  return false;
}

/** Upserts an entry record in a scope. */
export function upsertIncrementalScopeEntry(
  state: IncrementalSyncState,
  scopeId: string,
  entryKey: string,
  record: IncrementalEntryRecord,
): void {
  let scope = state.scopes[scopeId];
  if (scope === undefined) {
    scope = {
      initializedAt: new Date().toISOString(),
      entries: {},
    };
    state.scopes[scopeId] = scope;
  }
  scope.entries[entryKey] = record;
}

/** Builds a baseline incremental entry record without archiving article content. */
export function recordIncrementalBaselineEntry(input: {
  readonly fingerprint: string;
  readonly updatedAt?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly articleUrl?: string | undefined;
}): IncrementalEntryRecord {
  return {
    fingerprint: input.fingerprint,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.articleUrl ? { articleUrl: input.articleUrl } : {}),
    archivedCompleteness: "baseline",
  };
}

/**
 * Records a successfully archived entry, preserving any prior observed index
 * fingerprint during explicit backfill and clearing any recorded body gap.
 */
export function recordIncrementalArchivedEntry(
  previous: IncrementalEntryRecord | undefined,
  input: {
    readonly fingerprint?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly articleUrl?: string | undefined;
    readonly completeness: "partial" | "complete";
  },
): IncrementalEntryRecord {
  const effectiveFingerprint = input.fingerprint ?? previous?.fingerprint;
  if (effectiveFingerprint === undefined || effectiveFingerprint.length === 0) {
    throw new Error(
      "Cannot record an archived incremental entry without a fingerprint.",
    );
  }
  const effectiveUpdatedAt = input.updatedAt ?? previous?.updatedAt;
  const effectivePublishedAt = input.publishedAt ?? previous?.publishedAt;
  const effectiveArticleUrl = input.articleUrl ?? previous?.articleUrl;
  return {
    fingerprint: effectiveFingerprint,
    ...(effectiveUpdatedAt ? { updatedAt: effectiveUpdatedAt } : {}),
    ...(effectivePublishedAt ? { publishedAt: effectivePublishedAt } : {}),
    ...(effectiveArticleUrl ? { articleUrl: effectiveArticleUrl } : {}),
    archivedCompleteness: input.completeness,
    archivedFingerprint: effectiveFingerprint,
  };
}

/**
 * Records an article body fetch/extraction gap for the observed feed index
 * while never marking the failed version as archived.
 */
export function recordIncrementalBodyGapEntry(
  previous: IncrementalEntryRecord | undefined,
  input: {
    readonly fingerprint: string;
    readonly updatedAt?: string | undefined;
    readonly publishedAt?: string | undefined;
    readonly articleUrl: string;
    readonly gap: IncrementalBodyGapRecord;
  },
): IncrementalEntryRecord {
  const hasPreviousArchive =
    previous?.archivedCompleteness === "complete" ||
    previous?.archivedCompleteness === "partial";
  const previousArchivedFingerprint = hasPreviousArchive
    ? (previous.archivedFingerprint ?? previous.fingerprint)
    : undefined;
  return {
    fingerprint: input.fingerprint,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    articleUrl: input.articleUrl,
    ...(hasPreviousArchive
      ? {
          archivedCompleteness: previous.archivedCompleteness,
          ...(previousArchivedFingerprint
            ? { archivedFingerprint: previousArchivedFingerprint }
            : {}),
        }
      : {}),
    bodyGap: input.gap,
  };
}

/** Updates HTTP conditional validators (ETag, Last-Modified, scopeUrl) on a scope. */
export function updateIncrementalScopeValidators(
  state: IncrementalSyncState,
  scopeId: string,
  validators: {
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
    readonly scopeUrl?: string | undefined;
  },
): void {
  const scope = state.scopes[scopeId];
  if (scope === undefined) return;
  if ("etag" in validators) {
    if (validators.etag === undefined) delete scope.etag;
    else scope.etag = validators.etag;
  }
  if ("lastModified" in validators) {
    if (validators.lastModified === undefined) delete scope.lastModified;
    else scope.lastModified = validators.lastModified;
  }
  if ("scopeUrl" in validators) {
    if (validators.scopeUrl === undefined) delete scope.scopeUrl;
    else scope.scopeUrl = validators.scopeUrl;
  }
}

/** Upserts an ongoing document content hash in a scope. */
export function upsertIncrementalScopeOngoingDocument(
  state: IncrementalSyncState,
  scopeId: string,
  documentKey: string,
  record: IncrementalOngoingDocumentRecord,
): void {
  let scope = state.scopes[scopeId];
  if (scope === undefined) {
    scope = {
      initializedAt: new Date().toISOString(),
      entries: {},
    };
    state.scopes[scopeId] = scope;
  }
  if (scope.ongoingDocuments === undefined) {
    scope.ongoingDocuments = {};
  }
  scope.ongoingDocuments[documentKey] = record;
}

/** Computes a deterministic SHA-256 hex digest of cleaned markdown and text content. */
export function computeOngoingDocumentHash(
  markdown: string,
  text: string,
): string {
  return createHash("sha256")
    .update(markdown)
    .update("\0")
    .update(text)
    .digest("hex");
}

/** Determines whether an ongoing document's content hash has changed from its previous state. */
export function hasOngoingDocumentChanged(
  previous: IncrementalOngoingDocumentRecord | undefined,
  currentContentHash: string,
): boolean {
  if (previous === undefined) {
    return true;
  }
  return previous.contentHash !== currentContentHash;
}

/** Retrieves an ongoing document record for a scope and document key if present. */
export function getIncrementalScopeOngoingDocument(
  state: IncrementalSyncState,
  scopeId: string,
  documentKey: string,
): IncrementalOngoingDocumentRecord | undefined {
  return state.scopes[scopeId]?.ongoingDocuments?.[documentKey];
}

/** Prunes ongoing document records from a scope that are no longer in the active document keys, returning the removed keys. */
export function pruneInactiveOngoingDocuments(
  state: IncrementalSyncState,
  scopeId: string,
  activeDocumentKeys: Iterable<string>,
): string[] {
  const scope = state.scopes[scopeId];
  if (scope?.ongoingDocuments === undefined) {
    return [];
  }
  const activeSet = new Set(activeDocumentKeys);
  const removed: string[] = [];
  for (const key of Object.keys(scope.ongoingDocuments)) {
    if (!activeSet.has(key)) {
      delete scope.ongoingDocuments[key];
      removed.push(key);
    }
  }
  return removed;
}
