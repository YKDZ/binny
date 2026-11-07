// Shared incremental synchronization state schemas and management helpers.
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  sourceAdapterActionError,
  type SourceAdapterContext,
} from "./index.ts";

export const incrementalEntryRecordSchema = z
  .object({
    fingerprint: z.string().min(1),
    updatedAt: z.string().optional(),
    publishedAt: z.string().optional(),
    archivedCompleteness: z
      .enum(["baseline", "partial", "complete"])
      .optional(),
  })
  .strict();

export type IncrementalEntryRecord = z.infer<
  typeof incrementalEntryRecordSchema
>;

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
      suggestion: "检查运行器持久状态存储配置后重新触发。",
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
      suggestion: "检查持久状态存储后重新触发；不要手动清空状态。",
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
      suggestion: "检查持久状态存储内容或恢复有效备份后重新触发。",
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
      suggestion: "检查运行器持久状态存储配置后重新触发。",
      requiresHuman: false,
    });
  }
  const parsed = incrementalSyncStateSchema.safeParse(state);
  if (!parsed.success) {
    throw sourceAdapterActionError({
      code: "source_adapter_state_unavailable",
      message: "要保存的信源适配器持久状态格式无效。",
      impact: "本次同步已停止，状态未持久保存。",
      suggestion: "检查状态对象是否符合规范后重新触发。",
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
      suggestion: "检查持久状态存储后重新触发；不要手动清空状态。",
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
