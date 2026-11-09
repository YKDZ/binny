import { createHash } from "node:crypto";

import type { ArchiveResourceResolveItem } from "@binny/source-adapter-sdk";

/**
 * Discourse upload paths that encode a reliable 40-character hexadecimal SHA-1 digest.
 * Matches both original and optimized upload paths, with or without tree sharding.
 */
export const DISCOURSE_IMMUTABLE_MEDIA_REGEX =
  /(?:\/uploads\/default)?\/(?:original|optimized)\/\d+X\/(?:[0-9a-f]\/)*[0-9a-f]{40}(?:_\d+_\d+x\d+)?\.[a-z0-9]+$/iu;

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
  readonly created_at?: string | undefined;
  readonly category_id?: number | null | undefined;
  readonly tags?: readonly (string | { readonly name: string })[] | undefined;
};

export type DiscourseOpPost = {
  readonly id: number;
  readonly post_number: number;
  readonly title?: string | null | undefined;
  readonly created_at?: string | undefined;
  readonly username?: string | undefined;
  readonly name?: string | null | undefined;
  readonly cooked?: string | null | undefined;
  readonly updated_at?: string | undefined;
  readonly version?: number | undefined;
};

type SourceModifiedAt = ArchiveResourceResolveItem["state"]["sourceModifiedAt"];
type SourcePublishedAt =
  ArchiveResourceResolveItem["state"]["sourcePublishedAt"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  modifiedAtFn?: (post: DiscourseOpPost) => SourceModifiedAt,
  publishedAtFn?: (post: DiscourseOpPost) => SourcePublishedAt,
): boolean {
  if (archivedOp.state.capture.completeness !== "complete") {
    return false;
  }

  // 1. Verify updated_at / sourceModifiedAt timestamp.
  const currentModifiedAt = modifiedAtFn
    ? modifiedAtFn(post)
    : post.updated_at
      ? { precision: "instant", value: post.updated_at }
      : null;
  if (
    JSON.stringify(currentModifiedAt) !==
    JSON.stringify(archivedOp.state.sourceModifiedAt)
  ) {
    return false;
  }
  // Reuse only when the archived publication fact also matches the current post.
  const currentPublishedAt = publishedAtFn
    ? publishedAtFn(post)
    : post.created_at
      ? { precision: "instant", value: post.created_at }
      : null;
  if (
    JSON.stringify(currentPublishedAt) !==
    JSON.stringify(archivedOp.state.sourcePublishedAt)
  ) {
    return false;
  }

  const archivedExtensions = archivedOp.state.extensions;

  if (
    topic.id !== archivedExtensions.topicId ||
    post.post_number !== archivedExtensions.postNumber ||
    (post.username ?? null) !== archivedExtensions.authorUsername ||
    (post.name ?? null) !== archivedExtensions.authorName
  ) {
    return false;
  }

  // 2. Compare post version when available.
  if (
    post.version !== undefined &&
    archivedExtensions.postVersion !== undefined &&
    post.version !== archivedExtensions.postVersion
  ) {
    return false;
  }

  // 3. Compare cooked body hash when available.
  if (
    post.cooked !== undefined &&
    post.cooked !== null &&
    typeof archivedExtensions.cookedHash === "string"
  ) {
    const currentCookedHash = hashContent(post.cooked);
    if (currentCookedHash !== archivedExtensions.cookedHash) {
      return false;
    }
  }

  // 4. Compare the post's public title and the topic context used by its body.
  const archivedTopic = archivedExtensions.topic;
  if (!isRecord(archivedTopic)) return false;

  const postTitle = post.title?.trim() || null;
  if (postTitle !== archivedOp.state.title) {
    return false;
  }
  const archivedTopicTitle = archivedTopic.title ?? postTitle;
  if ((topic.title?.trim() || null) !== archivedTopicTitle) {
    return false;
  }

  if ((topic.category_id ?? null) !== (archivedExtensions.categoryId ?? null)) {
    return false;
  }

  if ((topic.slug ?? null) !== (archivedTopic.slug ?? null)) {
    return false;
  }
  if ((topic.created_at ?? null) !== archivedTopic.createdAt) {
    return false;
  }

  const currentTags = (topic.tags ?? [])
    .map((tag) => (typeof tag === "string" ? tag : tag.name))
    .toSorted((left, right) => left.localeCompare(right));
  const archivedTags = Array.isArray(archivedExtensions.tags)
    ? archivedExtensions.tags.toSorted((left, right) =>
        left.localeCompare(right),
      )
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
