import { createHash } from "node:crypto";

import type { ArchiveResourceResolveItem } from "@binny/source-adapter-sdk";

/**
 * Discourse upload paths that encode a reliable 40-character hexadecimal SHA-1 digest.
 * Matches both original and optimized upload paths, with or without tree sharding.
 */
export const DISCOURSE_IMMUTABLE_MEDIA_REGEX =
  /\/uploads\/default\/(?:original|optimized)\/\d+X\/(?:[0-9a-f]\/)*[0-9a-f]{40}(?:_\d+_\d+x\d+)?\.[a-z0-9]+$/iu;

/**
 * Check whether a media URL has an immutable content-hashed Discourse identity.
 * Non-content-hashed paths (e.g. /topic-photo.png) return false so they are re-verified.
 */
export function isDiscourseImmutableMediaUrl(
  url: string,
  siteOrigin: URL | string,
): boolean {
  try {
    const origin =
      typeof siteOrigin === "string" ? new URL(siteOrigin) : siteOrigin;
    const resolved = new URL(url, origin);
    return DISCOURSE_IMMUTABLE_MEDIA_REGEX.test(resolved.pathname);
  } catch {
    return false;
  }
}

export type DiscourseOpTopicMetadata = {
  readonly id: number;
  readonly title?: string | undefined;
  readonly slug?: string | undefined;
  readonly category_id?: number | null | undefined;
  readonly tags?: readonly (string | { readonly name: string })[] | undefined;
  readonly version?: number | undefined;
};

export type DiscourseOpPost = {
  readonly id: number;
  readonly post_number: number;
  readonly cooked?: string | null | undefined;
  readonly updated_at?: string | undefined;
  readonly version?: number | undefined;
};

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Check whether the OP post and its topic metadata remain unchanged compared to
 * the verified complete archived item revision.
 */
export function isOpUnchanged(
  topic: DiscourseOpTopicMetadata,
  post: DiscourseOpPost,
  archivedOp: ArchiveResourceResolveItem,
  modifiedAtFn?: (post: DiscourseOpPost) => string | undefined,
): boolean {
  if (archivedOp.state.capture.completeness !== "complete") {
    return false;
  }

  // 1. Verify updated_at / sourceModifiedAt timestamp.
  const currentModifiedAt = modifiedAtFn
    ? modifiedAtFn(post)
    : post.updated_at
      ? new Date(Date.parse(post.updated_at)).toISOString()
      : undefined;
  if (currentModifiedAt !== archivedOp.state.sourceModifiedAt) {
    return false;
  }

  const archivedMetadata = archivedOp.state.metadata;
  if (!archivedMetadata) {
    return false;
  }

  // 2. Compare post version when available.
  if (
    post.version !== undefined &&
    archivedMetadata.postVersion !== undefined &&
    post.version !== archivedMetadata.postVersion
  ) {
    return false;
  }

  // 3. Compare cooked body hash when available.
  if (
    post.cooked !== undefined &&
    post.cooked !== null &&
    typeof archivedMetadata.cookedHash === "string"
  ) {
    const currentCookedHash = hashContent(post.cooked);
    if (currentCookedHash !== archivedMetadata.cookedHash) {
      return false;
    }
  }

  // 4. Compare topic metadata (title, categoryId, slug, tags).
  const archivedTopic = archivedMetadata.topic as
    | Record<string, unknown>
    | undefined;
  if (!archivedTopic) {
    return false;
  }

  if ((topic.title ?? null) !== (archivedTopic.title ?? null)) {
    return false;
  }

  if ((topic.category_id ?? null) !== (archivedTopic.categoryId ?? null)) {
    return false;
  }

  if ((topic.slug ?? null) !== (archivedTopic.slug ?? null)) {
    return false;
  }

  if (
    topic.version !== undefined &&
    archivedTopic.version !== undefined &&
    topic.version !== archivedTopic.version
  ) {
    return false;
  }

  const currentTags = (topic.tags ?? [])
    .map((tag) => (typeof tag === "string" ? tag : tag.name))
    .toSorted();
  const archivedTags = Array.isArray(archivedTopic.tags)
    ? (archivedTopic.tags as string[]).toSorted()
    : [];

  if (currentTags.length !== archivedTags.length) {
    return false;
  }
  for (let i = 0; i < currentTags.length; i++) {
    if (currentTags[i] !== archivedTags[i]) {
      return false;
    }
  }

  return true;
}
