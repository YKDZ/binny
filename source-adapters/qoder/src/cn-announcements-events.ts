// Qoder CN Announcements and Events discovery, extraction, and ongoing-document sync.
import type { SourceAdapterContext } from "@binny/source-adapter-sdk";
import {
  computeOngoingDocumentHash,
  getIncrementalScopeOngoingDocument,
  hasOngoingDocumentChanged,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  pruneInactiveOngoingDocuments,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  submitCleanedArticle,
  upsertIncrementalScopeOngoingDocument,
  type IncrementalOngoingDocumentRecord,
} from "@binny/source-adapter-sdk";

import { cleanQoderMdx } from "./mdx-cleaner.ts";
import type {
  QoderCheckOutput,
  QoderCollectOutput,
  QoderCollectParams,
  QoderConfig,
  QoderSyncOutput,
} from "./source-adapter.ts";

export const CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID = "cn-announcements-events";
export const DEFAULT_CN_DOCS_INDEX_URL = "https://docs.qoder.cn/llms.txt";

export interface DiscoveredCnDoc {
  readonly title: string;
  readonly docKey: string;
  readonly canonicalUrl: string;
  readonly fetchUrl: string;
  readonly section: string;
  readonly description?: string | undefined;
}

/**
 * Extracts a normalized document key from a URL or relative path.
 * Strips leading/trailing slashes and .md/.html extensions.
 * e.g. "/events/purchase-offer.md" -> "events/purchase-offer"
 */
export function extractDocKey(urlOrPath: string): string {
  try {
    const parsed = new URL(urlOrPath, "https://docs.qoder.cn");
    return parsed.pathname
      .replace(/^\/+/u, "")
      .replace(/\/+$/u, "")
      .replace(/\.(?:md|html)$/iu, "");
  } catch {
    return urlOrPath
      .replace(/^\/+/u, "")
      .replace(/\/+$/u, "")
      .replace(/\.(?:md|html)$/iu, "");
  }
}

/** Builds the canonical web document URL without .md extension. */
export function buildCanonicalDocUrl(docKey: string, baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}/${docKey}`;
  } catch {
    return `https://docs.qoder.cn/${docKey}`;
  }
}

/** Builds the markdown fetch URL with .md extension. */
export function buildFetchMdUrl(rawUrl: string, baseUrl: string): string {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    if (parsed.pathname.endsWith(".md")) {
      return parsed.href;
    }
    const cleanPath = parsed.pathname
      .replace(/\/+$/u, "")
      .replace(/\.html$/iu, "");
    parsed.pathname = `${cleanPath}.md`;
    return parsed.href;
  } catch {
    const docKey = extractDocKey(rawUrl);
    return `https://docs.qoder.cn/${docKey}.md`;
  }
}

/**
 * Determines whether a Markdown section heading in llms.txt represents an
 * announcement or event group (e.g. ## 产品公告, ## 事件, ## 公告, ## 活动).
 */
export function isAnnouncementOrEventSectionHeading(heading: string): boolean {
  const normalized = heading.trim().toLowerCase();
  return (
    /^(?:产品)?公告/u.test(normalized) ||
    /^(?:最新)?事件/u.test(normalized) ||
    /^(?:最新)?活动/u.test(normalized) ||
    normalized.includes("announcement") ||
    normalized.includes("event")
  );
}

/**
 * Discovers active announcement and event documents from llms.txt content.
 * Parses sections and extracts Markdown links under matching announcement/event headings.
 */
export function discoverCnAnnouncementDocs(
  llmsText: string,
  baseUrl = DEFAULT_CN_DOCS_INDEX_URL,
): DiscoveredCnDoc[] {
  const lines = llmsText.split(/\r?\n/u);
  let inMatchingSection = false;
  let currentSection = "";
  const docs: DiscoveredCnDoc[] = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/u, "").trim();
      if (line.startsWith("## ")) {
        inMatchingSection = isAnnouncementOrEventSectionHeading(heading);
        currentSection = heading;
      } else {
        inMatchingSection = false;
      }
      continue;
    }

    if (!inMatchingSection) continue;

    const match = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/u);
    if (!match) continue;

    const title = match[1]!.trim();
    const rawUrl = match[2]!.trim();
    const description = match[3]?.trim();

    const docKey = extractDocKey(rawUrl);
    if (docKey.length === 0 || seenKeys.has(docKey)) continue;
    seenKeys.add(docKey);

    const canonicalUrl = buildCanonicalDocUrl(docKey, baseUrl);
    const fetchUrl = buildFetchMdUrl(rawUrl, baseUrl);

    docs.push({
      title,
      docKey,
      canonicalUrl,
      fetchUrl,
      section: currentSection,
      ...(description && description.length > 0 ? { description } : {}),
    });
  }

  return docs;
}

/**
 * Extracts business effective dates or ranges from event text.
 * NOTE: This is an event effective date, NOT an article publication timestamp.
 */
export function extractEffectiveDate(text: string): string | undefined {
  const timeLineMatch = text.match(
    /(?:活动时间|有效时间|活动期限|特惠时间)[*_~]*\s*[：:]\s*([^\n。；\r]+)/u,
  );
  if (timeLineMatch?.[1]) {
    const candidate = timeLineMatch[1].trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  const rangeMatch = text.match(
    /\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号]?(?:\s*\d{1,2}:\d{2})?\s*(?:—|–|-|~|至|到)\s*(?:\d{4}\s*[年./-]\s*)?\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号]?(?:\s*\d{1,2}:\d{2})?/u,
  );
  if (rangeMatch?.[0]) {
    return rangeMatch[0].trim();
  }

  const sinceMatch = text.match(
    /(?:自|从)\s*(\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号]?(?:[^\n。；\r]*?(?:开始|起))?)/u,
  );
  if (sinceMatch?.[1]) {
    return sinceMatch[1].trim();
  }

  const singleMatch = text.match(
    /\b\d{4}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*[日号]?\b/u,
  );
  if (singleMatch?.[0]) {
    return singleMatch[0].trim();
  }

  return undefined;
}

/** Checks whether a response text is an HTML SPA shell or error page instead of markdown. */
export function isHtmlSpaOrError(text: string): boolean {
  if (/<(!doctype\s+html|html|head)[\s>]/iu.test(text)) {
    if (/<div\s+id=["'](root|app|__next)["']\s*>\s*<\/div>/iu.test(text)) {
      return true;
    }
    if (
      /<title[^>]*>.*?(404|not\s+found|error|forbidden|页面不存在|错误).*?<\/title>/iu.test(
        text,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Fetches a text document with timeout and abort signal handling. */
async function fetchText(
  url: string,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<string> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/markdown, text/plain, */*",
      "user-agent": "Binny SourceAdapter/1.0",
    },
    signal: requestSignal,
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Fetch failed: ${url} returned HTTP ${response.status}`);
  }

  const text = await response.text();
  if (isHtmlSpaOrError(text)) {
    throw new Error(
      `Fetch failed: ${url} returned an HTML SPA shell or error page instead of markdown`,
    );
  }

  return text;
}

function failureFromProblems(
  problems: readonly { docKey: string; message: string }[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 5)
    .map((p) => `${p.docKey}: ${p.message}`)
    .join("; ");
  return sourceAdapterActionError(
    {
      code: "qoder_cn_announcements_events_incomplete",
      message: `Qoder CN announcements and events synchronization incomplete: ${examples}`,
      impact:
        "Affected announcements or events were not archived or their ongoing document progress was not advanced.",
      suggestion:
        "Check Qoder CN documentation index and detail markdown page availability.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

/** Checks Qoder CN documentation index availability. */
export async function checkCnAnnouncementsEvents(
  context: SourceAdapterContext<QoderConfig>,
): Promise<QoderCheckOutput> {
  const indexUrl = context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL;

  try {
    const text = await fetchText(indexUrl, context.signal, 10_000);
    const docs = discoverCnAnnouncementDocs(text, indexUrl);

    if (docs.length === 0 && !text.includes("#")) {
      return {
        availability: "unavailable",
        scope: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
        basis: `Qoder CN documentation index responded but contained no recognized Markdown headings.`,
        problems: [
          {
            code: "qoder_cn_docs_index_empty",
            message:
              "Documentation index does not contain recognized headings.",
            impact: "Cannot discover Qoder CN announcements or events.",
            suggestion: "Verify that the index URL points to a valid llms.txt.",
            requiresHuman: false,
          },
        ],
      };
    }

    return {
      availability: "available",
      scope: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      basis: `Qoder CN documentation index is reachable and contains ${docs.length} active announcements/events.`,
      problems: [],
    };
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      basis: `Failed to reach Qoder CN documentation index at ${indexUrl}: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "qoder_cn_docs_index_unreachable",
          message: error instanceof Error ? error.message : "Index unreachable",
          impact: "Cannot discover Qoder CN announcements and events.",
          suggestion: "Verify network connectivity and URL configuration.",
          requiresHuman: false,
        },
      ],
    };
  }
}

/**
 * Incrementally synchronizes active Qoder CN announcements and events using
 * active directory ongoing-document semantics.
 */
export async function syncCnAnnouncementsEvents(
  context: SourceAdapterContext<QoderConfig>,
): Promise<QoderSyncOutput> {
  const indexUrl = context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL;
  const state = await loadIncrementalSyncState(context);

  const indexText = await fetchText(indexUrl, context.signal);
  const activeDocs = discoverCnAnnouncementDocs(indexText, indexUrl);
  const activeKeys = new Set(activeDocs.map((doc) => doc.docKey));

  const isInitialized = isIncrementalScopeInitialized(
    state,
    CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
  );

  const problems: { docKey: string; message: string }[] = [];
  let hasFailures = false;

  if (!isInitialized) {
    // Initial sync establishes baseline: fetches active pages, computes ongoing hashes,
    // and records baseline state WITHOUT submitting to archive.
    const baselineOngoingDocs: Record<
      string,
      IncrementalOngoingDocumentRecord
    > = {};

    for (const doc of activeDocs) {
      if (context.signal.aborted) throw context.signal.reason;
      try {
        const rawMd = await fetchText(doc.fetchUrl, context.signal);
        const { cleanResult } = cleanQoderMdx(rawMd, {
          baseUrl: doc.canonicalUrl,
        });
        const contentHash = computeOngoingDocumentHash(
          cleanResult.markdown,
          cleanResult.text,
        );
        baselineOngoingDocs[doc.docKey] = { contentHash };
      } catch (error) {
        if (context.signal.aborted) throw error;
        hasFailures = true;
        problems.push({
          docKey: doc.docKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (hasFailures) {
      throw failureFromProblems(problems, []);
    }

    initializeIncrementalScope(state, CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID, {
      scopeUrl: indexUrl,
      initializedAt: new Date().toISOString(),
      ongoingDocuments: baselineOngoingDocs,
    });
    await saveIncrementalSyncState(context, state);

    return {
      completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
      initializedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
    };
  }

  // Subsequent sync:
  // 1. Prune pages that have exited the active announcement/event directory.
  pruneInactiveOngoingDocuments(
    state,
    CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
    activeKeys,
  );

  // 2. Check each currently active page for in-place content changes.
  for (const doc of activeDocs) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const rawMd = await fetchText(doc.fetchUrl, context.signal);
      const { cleanResult } = cleanQoderMdx(rawMd, {
        baseUrl: doc.canonicalUrl,
      });
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );

      const previous = getIncrementalScopeOngoingDocument(
        state,
        CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
        doc.docKey,
      );

      if (hasOngoingDocumentChanged(previous, contentHash)) {
        const effectiveDate = extractEffectiveDate(rawMd);
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: {
            namespace: "qoder:cn-docs",
            key: doc.docKey,
          },
          sourceRef: doc.canonicalUrl,
          title: doc.title,
          sourceModifiedAt: undefined, // NEVER fabricate!
          metadata: {
            region: "cn",
            language: "zh-CN",
            title: doc.title,
            section: doc.section,
            ...(doc.description ? { summary: doc.description } : {}),
            ...(effectiveDate ? { effectiveDate } : {}),
          },
          cleanResult,
          captureScope: {
            scopeId: CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
            scopeUrl: indexUrl,
            documentKey: doc.docKey,
          },
        });

        upsertIncrementalScopeOngoingDocument(
          state,
          CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
          doc.docKey,
          { contentHash },
        );
        await saveIncrementalSyncState(context, state);

        if (submitResult.problems.length > 0) {
          for (const msg of submitResult.problems) {
            problems.push({ docKey: doc.docKey, message: msg });
          }
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      hasFailures = true;
      problems.push({
        docKey: doc.docKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasFailures || problems.length > 0) {
    throw failureFromProblems(
      problems,
      hasFailures ? [] : [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
    );
  }

  await saveIncrementalSyncState(context, state);

  return {
    completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
  };
}

/** Explicitly collects Qoder CN announcements and events. */
export async function collectCnAnnouncementsEvents(
  context: SourceAdapterContext<QoderConfig>,
  params: QoderCollectParams,
): Promise<QoderCollectOutput> {
  const indexUrl = context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL;
  const state = await loadIncrementalSyncState(context);

  let targetDocs: DiscoveredCnDoc[] = [];

  if (params.articleUrls && params.articleUrls.length > 0) {
    for (const url of params.articleUrls) {
      if (
        /changelog\.qoder\.cn/iu.test(url) ||
        /changelog\.qoder\.com/iu.test(url)
      ) {
        continue;
      }
      const docKey = extractDocKey(url);
      if (docKey.length > 0) {
        targetDocs.push({
          title: docKey,
          docKey,
          canonicalUrl: buildCanonicalDocUrl(docKey, indexUrl),
          fetchUrl: buildFetchMdUrl(url, indexUrl),
          section: "Explicit Collect",
        });
      }
    }
  } else {
    const indexText = await fetchText(indexUrl, context.signal);
    const discovered = discoverCnAnnouncementDocs(indexText, indexUrl);
    targetDocs =
      params.maxItems !== undefined && params.maxItems > 0
        ? discovered.slice(0, params.maxItems)
        : discovered;
  }

  const problems: { docKey: string; message: string }[] = [];
  let hasFailures = false;

  for (const doc of targetDocs) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const rawMd = await fetchText(doc.fetchUrl, context.signal);
      const { cleanResult } = cleanQoderMdx(rawMd, {
        baseUrl: doc.canonicalUrl,
      });
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const effectiveDate = extractEffectiveDate(rawMd);

      const submitResult = await submitCleanedArticle(context, {
        sourceKey: {
          namespace: "qoder:cn-docs",
          key: doc.docKey,
        },
        sourceRef: doc.canonicalUrl,
        title: doc.title,
        sourceModifiedAt: undefined,
        metadata: {
          region: "cn",
          language: "zh-CN",
          title: doc.title,
          section: doc.section,
          ...(doc.description ? { summary: doc.description } : {}),
          ...(effectiveDate ? { effectiveDate } : {}),
        },
        cleanResult,
        captureScope: {
          scopeId: CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
          scopeUrl: indexUrl,
          documentKey: doc.docKey,
        },
      });

      upsertIncrementalScopeOngoingDocument(
        state,
        CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID,
        doc.docKey,
        { contentHash },
      );
      await saveIncrementalSyncState(context, state);

      if (submitResult.problems.length > 0) {
        for (const msg of submitResult.problems) {
          problems.push({ docKey: doc.docKey, message: msg });
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      hasFailures = true;
      problems.push({
        docKey: doc.docKey,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasFailures || problems.length > 0) {
    throw failureFromProblems(
      problems,
      hasFailures ? [] : [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
    );
  }

  await saveIncrementalSyncState(context, state);

  return {
    completedScopes: [CN_ANNOUNCEMENTS_EVENTS_SCOPE_ID],
  };
}
