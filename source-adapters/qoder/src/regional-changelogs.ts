// Qoder regional product changelogs (CN and International) discovery, extraction,
// and ongoing-document whole-page revision sync.
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

import {
  buildCanonicalDocUrl,
  buildFetchMdUrl,
  DEFAULT_CN_DOCS_INDEX_URL,
  extractDocKey,
  isHtmlSpaOrError,
} from "./cn-announcements-events.ts";
import {
  cleanQoderMdx,
  extractQoderDocumentTitle,
  type QoderMdxUpdate,
} from "./mdx-cleaner.ts";
import type {
  QoderCheckOutput,
  QoderCollectOutput,
  QoderCollectParams,
  QoderConfig,
  QoderExtensions,
  QoderSyncOutput,
} from "./source-adapter.ts";

export const CN_CHANGELOGS_SCOPE_ID = "cn-changelogs";
export const INTERNATIONAL_CHANGELOGS_SCOPE_ID = "int-changelogs";
export const DEFAULT_CN_CHANGELOG_URL = "https://changelog.qoder.cn/llms.txt";
export const DEFAULT_INTERNATIONAL_CHANGELOG_URL =
  "https://changelog.qoder.com/llms.txt";

export interface DiscoveredChangelogDoc {
  readonly title: string;
  readonly docKey: string;
  readonly canonicalUrl: string;
  readonly fetchUrl: string;
  readonly section?: string | undefined;
  readonly description?: string | undefined;
}

export interface CardLink {
  readonly title?: string | undefined;
  readonly href: string;
}

export interface ParsedUpdateDate {
  readonly date: string;
  readonly precision: "day" | "month";
}

export interface ParsedChangelogMetadata {
  readonly latestUpdateLabel?: string | undefined;
  readonly latestVersion?: string | undefined;
  readonly latestUpdateDate?: string | undefined;
  readonly latestUpdateDatePrecision?: "day" | "month" | undefined;
}

/**
 * Determines whether a Markdown section heading in llms.txt represents a
 * changelog group (e.g. ## 更新日志, ## 变更日志, ## Changelogs, ## Release Notes).
 */
export function isChangelogSectionHeading(heading: string): boolean {
  const normalized = heading.trim().toLowerCase();
  return (
    normalized.includes("更新日志") ||
    normalized.includes("变更日志") ||
    normalized.includes("changelog") ||
    normalized.includes("release note") ||
    normalized.includes("release-note")
  );
}

/**
 * Identifies whether a document key represents a navigation overview page
 * that is used solely for discovery and must NOT be archived as a changelog body.
 */
export function isNavigationDocKey(docKey: string): boolean {
  const normalized = docKey.toLowerCase();
  return (
    normalized.endsWith("qoder-cn-update-log") ||
    normalized.endsWith("qoder-update-log-overview") ||
    normalized.endsWith("update-log-overview") ||
    normalized.endsWith("/overview") ||
    normalized === "overview" ||
    normalized === "changelogs" ||
    normalized === "release-notes"
  );
}

/**
 * Identifies whether a raw markdown text represents a navigation-only card page
 * rather than an actual changelog body (i.e. contains Card links and no Update blocks).
 */
export function isNavigationPageContent(rawMarkdown: string): boolean {
  const hasCards = /<Card\b/iu.test(rawMarkdown);
  const hasUpdates = /<Update\b/iu.test(rawMarkdown);
  const hasReleaseHeadings =
    /^#{2,3}\s+(?:v?\d+\.\d+|\d{4}[-./]\d{1,2}|\[\d+\.\d+)/mu.test(rawMarkdown);
  return hasCards && !hasUpdates && !hasReleaseHeadings;
}

/**
 * Extracts <Card ... href="..."> links from an MDX navigation overview page.
 */
export function extractCardLinks(mdxContent: string): CardLink[] {
  const cards: CardLink[] = [];
  const cardRegex = /<Card\b([^>]*)>(?:([\s\S]*?)<\/Card>)?/giu;
  let match: RegExpExecArray | null;

  while ((match = cardRegex.exec(mdxContent)) !== null) {
    const attrsStr = match[1] ?? "";
    const bodyContent = match[2]?.trim() ?? "";

    const hrefMatch = attrsStr.match(/\bhref=(?:"([^"]*)"|'([^']*)')/u);
    const titleMatch = attrsStr.match(/\btitle=(?:"([^"]*)"|'([^']*)')/u);

    const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? "").trim();
    let title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim();
    if (!title && bodyContent) {
      const firstLine = bodyContent.split(/\r?\n/u)[0]?.trim();
      if (firstLine && !firstLine.startsWith("<")) {
        title = firstLine;
      }
    }

    if (href.length > 0) {
      cards.push({
        href,
        ...(title.length > 0 ? { title } : {}),
      });
    }
  }

  return cards;
}

/**
 * Parses date string into normalized date and precision ("day" or "month").
 * Does not fabricate full ISO timestamps.
 */
export function parseUpdateDate(input: string): ParsedUpdateDate | undefined {
  const str = input.trim();

  // 1. Day formats:
  // YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD
  const dayMatch = str.match(/\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/u);
  if (dayMatch) {
    const year = dayMatch[1];
    const month = dayMatch[2]!.padStart(2, "0");
    const day = dayMatch[3]!.padStart(2, "0");
    return {
      date: `${year}-${month}-${day}`,
      precision: "day",
    };
  }

  // Chinese format: 2026年10月29日
  const cnDayMatch = str.match(
    /\b(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u,
  );
  if (cnDayMatch) {
    const year = cnDayMatch[1];
    const month = cnDayMatch[2]!.padStart(2, "0");
    const day = cnDayMatch[3]!.padStart(2, "0");
    return {
      date: `${year}-${month}-${day}`,
      precision: "day",
    };
  }

  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const shortMonthNames = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  // English format with day: October 29, 2026 or 29 October 2026
  const engDayMatch = str.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/u);
  if (engDayMatch) {
    const mStr = engDayMatch[1]!.toLowerCase();
    let mIdx = monthNames.indexOf(mStr);
    if (mIdx === -1) mIdx = shortMonthNames.indexOf(mStr);
    if (mIdx !== -1) {
      const year = engDayMatch[3];
      const month = String(mIdx + 1).padStart(2, "0");
      const day = engDayMatch[2]!.padStart(2, "0");
      return {
        date: `${year}-${month}-${day}`,
        precision: "day",
      };
    }
  }

  // 2. Month formats:
  // English format with month only: October 2026 or Oct 2026
  const engMonthMatch = str.match(/\b([A-Za-z]+)\s+(\d{4})\b/u);
  if (engMonthMatch) {
    const mStr = engMonthMatch[1]!.toLowerCase();
    let mIdx = monthNames.indexOf(mStr);
    if (mIdx === -1) mIdx = shortMonthNames.indexOf(mStr);
    if (mIdx !== -1) {
      const year = engMonthMatch[2];
      const month = String(mIdx + 1).padStart(2, "0");
      return {
        date: `${year}-${month}`,
        precision: "month",
      };
    }
  }

  // YYYY-MM, YYYY.MM, YYYY/MM
  const monthMatch = str.match(/\b(\d{4})[-./](\d{1,2})\b/u);
  if (monthMatch) {
    const year = monthMatch[1];
    const month = monthMatch[2]!.padStart(2, "0");
    return {
      date: `${year}-${month}`,
      precision: "month",
    };
  }

  // Chinese format: 2026年10月
  const cnMonthMatch = str.match(/\b(\d{4})\s*年\s*(\d{1,2})\s*月\b/u);
  if (cnMonthMatch) {
    const year = cnMonthMatch[1];
    const month = cnMonthMatch[2]!.padStart(2, "0");
    return {
      date: `${year}-${month}`,
      precision: "month",
    };
  }

  return undefined;
}

/**
 * Extracts a version string from an update label or description.
 * e.g. "0.5.3", "v0.5.3", "CLI 1.1.82", "Qoder 0.5.3" -> "1.1.82", "0.5.3"
 */
export function extractVersion(input: string): string | undefined {
  const trimmed = input.trim();
  const match = trimmed.match(
    /\b(?:v)?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)\b/u,
  );
  if (match) {
    return match[1];
  }
  return undefined;
}

/**
 * Extracts changelog metadata from MDX updates or headings.
 */
export function parseChangelogMetadata(
  updates: readonly QoderMdxUpdate[],
  markdown: string,
): ParsedChangelogMetadata {
  let latestUpdateLabel: string | undefined;
  let latestVersion: string | undefined;
  let latestUpdateDate: string | undefined;
  let latestUpdateDatePrecision: "day" | "month" | undefined;

  if (updates.length > 0) {
    const firstUpdate = updates[0]!;
    latestUpdateLabel = firstUpdate.label;

    // Check label first for date, then description
    const labelDateInfo = parseUpdateDate(firstUpdate.label);
    if (labelDateInfo) {
      latestUpdateDate = labelDateInfo.date;
      latestUpdateDatePrecision = labelDateInfo.precision;
    } else if (firstUpdate.description) {
      const descDateInfo = parseUpdateDate(firstUpdate.description);
      if (descDateInfo) {
        latestUpdateDate = descDateInfo.date;
        latestUpdateDatePrecision = descDateInfo.precision;
      }
    }

    // Check description first for version, then label
    const rawDesc = firstUpdate.description?.trim();
    const descVersion = rawDesc
      ? (extractVersion(rawDesc) ?? rawDesc)
      : undefined;
    const labelVersion = extractVersion(firstUpdate.label);

    if (descVersion) {
      latestVersion = descVersion;
    } else if (labelVersion) {
      latestVersion = labelVersion;
    }
  } else {
    // Fallback: look for headings like ## 2026-10-29 (0.5.3) or ## 0.5.3
    const headingMatch = markdown.match(
      /^##\s+(?:\[?([^\n()]+)\]?)(?:\s*\(([^)]+)\))?/mu,
    );
    if (headingMatch) {
      const part1 = headingMatch[1]?.trim() ?? "";
      const part2 = headingMatch[2]?.trim() ?? "";
      latestUpdateLabel = part1;

      const dateInfo = parseUpdateDate(part1) ?? parseUpdateDate(part2);
      if (dateInfo) {
        latestUpdateDate = dateInfo.date;
        latestUpdateDatePrecision = dateInfo.precision;
      }

      const version =
        extractVersion(part2) ??
        extractVersion(part1) ??
        (part2.length > 0 ? part2 : undefined);
      if (version) {
        latestVersion = version;
      }
    }
  }

  return {
    latestUpdateLabel,
    latestVersion,
    latestUpdateDate,
    latestUpdateDatePrecision,
  };
}

/**
 * Discovers active CN product changelog documents from docs.qoder.cn/llms.txt.
 * Follows navigation overview page (e.g. qoder-cn-update-log.md) to extract linked
 * product changelog pages, and excludes the navigation page itself.
 */
export async function discoverCnChangelogDocs(
  llmsText: string,
  baseUrl: string = DEFAULT_CN_DOCS_INDEX_URL,
  fetchFn?: (url: string) => Promise<string>,
): Promise<DiscoveredChangelogDoc[]> {
  const lines = llmsText.split(/\r?\n/u);

  let hasNonEmptyH2 = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.replace(/^#+\s*/u, "").trim();
      if (heading.length > 0) {
        hasNonEmptyH2 = true;
        break;
      }
    }
  }

  let inChangelogSection = !hasNonEmptyH2;
  let currentSection = inChangelogSection ? "更新日志" : "";
  const directDocs: DiscoveredChangelogDoc[] = [];
  const navigationUrls: string[] = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/u, "").trim();
      if (line.startsWith("## ")) {
        if (heading.length > 0) {
          inChangelogSection = isChangelogSectionHeading(heading);
          currentSection = inChangelogSection ? heading : "";
        }
      } else if (hasNonEmptyH2) {
        inChangelogSection = false;
        currentSection = "";
      }
      continue;
    }

    if (!inChangelogSection) continue;

    const match = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/u);
    if (!match) continue;

    const title = match[1]!.trim();
    const rawUrl = match[2]!.trim();
    const description = match[3]?.trim();

    const docKey = extractDocKey(rawUrl);
    if (docKey.length === 0) continue;

    const fetchUrl = buildFetchMdUrl(rawUrl, baseUrl);

    if (isNavigationDocKey(docKey)) {
      navigationUrls.push(fetchUrl);
      continue;
    }

    if (!seenKeys.has(docKey)) {
      seenKeys.add(docKey);
      directDocs.push({
        title,
        docKey,
        canonicalUrl: buildCanonicalDocUrl(docKey, baseUrl),
        fetchUrl,
        section: currentSection || "更新日志",
        ...(description && description.length > 0 ? { description } : {}),
      });
    }
  }

  // If navigation overview page is present and fetchFn is available, fetch and extract linked product changelogs
  if (navigationUrls.length > 0 && fetchFn) {
    for (const navUrl of navigationUrls) {
      try {
        const navText = await fetchFn(navUrl);
        const cards = extractCardLinks(navText);
        for (const card of cards) {
          const cardDocKey = extractDocKey(card.href);
          if (
            cardDocKey.length > 0 &&
            !isNavigationDocKey(cardDocKey) &&
            !seenKeys.has(cardDocKey)
          ) {
            seenKeys.add(cardDocKey);
            directDocs.push({
              title: card.title ?? cardDocKey,
              docKey: cardDocKey,
              canonicalUrl: buildCanonicalDocUrl(cardDocKey, baseUrl),
              fetchUrl: buildFetchMdUrl(card.href, baseUrl),
              section: currentSection || "更新日志",
            });
          }
        }
      } catch (error) {
        throw new Error(
          `Failed to fetch navigation overview page ${navUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (directDocs.length === 0 && navigationUrls.length === 0 && fetchFn) {
    let isDocsHost = false;
    try {
      isDocsHost = new URL(baseUrl).hostname === "docs.qoder.cn";
    } catch {
      isDocsHost = false;
    }
    if (isDocsHost) {
      const cnChangelogText = await fetchFn(DEFAULT_CN_CHANGELOG_URL);
      return await discoverCnChangelogDocs(
        cnChangelogText,
        DEFAULT_CN_CHANGELOG_URL,
        fetchFn,
      );
    }
  }

  return directDocs;
}

/**
 * Discovers active International product changelog documents from changelog.qoder.com/llms.txt.
 * Follows navigation overview pages if present, and excludes navigation pages from results.
 */
export async function discoverInternationalChangelogDocs(
  llmsText: string,
  baseUrl: string = DEFAULT_INTERNATIONAL_CHANGELOG_URL,
  fetchFn?: (url: string) => Promise<string>,
): Promise<DiscoveredChangelogDoc[]> {
  const lines = llmsText.split(/\r?\n/u);
  let hasSections = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.replace(/^#+\s*/u, "").trim();
      if (heading.length > 0) {
        hasSections = true;
        break;
      }
    }
  }

  let inChangelogSection = !hasSections;
  let currentSection = inChangelogSection ? "Changelog" : "";
  const directDocs: DiscoveredChangelogDoc[] = [];
  const navigationUrls: string[] = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("#")) {
      const heading = line.replace(/^#+\s*/u, "").trim();
      if (line.startsWith("## ")) {
        if (heading.length > 0) {
          inChangelogSection = isChangelogSectionHeading(heading);
          currentSection = inChangelogSection ? heading : "";
        }
      } else if (!hasSections && line.startsWith("# ")) {
        inChangelogSection = true;
        currentSection = "Changelog";
      } else if (hasSections) {
        inChangelogSection = false;
        currentSection = "";
      }
      continue;
    }

    if (hasSections && !inChangelogSection) continue;

    const match = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/u);
    if (!match) continue;

    const title = match[1]!.trim();
    const rawUrl = match[2]!.trim();
    const description = match[3]?.trim();

    const docKey = extractDocKey(rawUrl);
    if (docKey.length === 0) continue;

    const fetchUrl = buildFetchMdUrl(rawUrl, baseUrl);

    if (isNavigationDocKey(docKey)) {
      navigationUrls.push(fetchUrl);
      continue;
    }

    if (!seenKeys.has(docKey)) {
      seenKeys.add(docKey);
      directDocs.push({
        title,
        docKey,
        canonicalUrl: buildCanonicalDocUrl(docKey, baseUrl),
        fetchUrl,
        section: currentSection || "Changelog",
        ...(description && description.length > 0 ? { description } : {}),
      });
    }
  }

  if (navigationUrls.length > 0 && fetchFn) {
    for (const navUrl of navigationUrls) {
      try {
        const navText = await fetchFn(navUrl);
        const cards = extractCardLinks(navText);
        for (const card of cards) {
          const cardDocKey = extractDocKey(card.href);
          if (
            cardDocKey.length > 0 &&
            !isNavigationDocKey(cardDocKey) &&
            !seenKeys.has(cardDocKey)
          ) {
            seenKeys.add(cardDocKey);
            directDocs.push({
              title: card.title ?? cardDocKey,
              docKey: cardDocKey,
              canonicalUrl: buildCanonicalDocUrl(cardDocKey, baseUrl),
              fetchUrl: buildFetchMdUrl(card.href, baseUrl),
              section: currentSection || "Changelog",
            });
          }
        }
      } catch (error) {
        throw new Error(
          `Failed to fetch navigation overview page ${navUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return directDocs;
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
  scopeId: string,
  problems: readonly { docKey: string; message: string }[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 5)
    .map((p) => `${p.docKey}: ${p.message}`)
    .join("; ");
  return sourceAdapterActionError(
    {
      code: `qoder_${scopeId.replaceAll("-", "_")}_incomplete`,
      message: `Qoder ${scopeId} synchronization incomplete: ${examples}`,
      impact:
        "Affected changelog documents were not archived or their ongoing document progress was not advanced.",
      suggestion:
        "Check Qoder changelog index and detail markdown page availability.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

/** Checks Qoder CN documentation index reachability and verifies extraction on 1 sample document. */
export async function checkCnChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderCheckOutput> {
  const indexUrl = context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL;
  try {
    const text = await fetchText(indexUrl, context.signal, 10_000);
    const docs = await discoverCnChangelogDocs(text, indexUrl, (u) =>
      fetchText(u, context.signal, 10_000),
    );

    if (docs.length === 0) {
      return {
        availability: "unavailable",
        scope: [CN_CHANGELOGS_SCOPE_ID],
        basis: `Qoder CN documentation index responded but contained no active changelog documents.`,
        problems: [
          {
            code: "qoder_cn_changelogs_empty",
            message: "No product changelog documents discovered in index.",
            impact: "Cannot synchronize Qoder CN product changelogs.",
            suggestion: "Verify that the index contains a changelog section.",
            requiresHuman: false,
          },
        ],
      };
    }

    const sampleDoc = docs[0]!;
    const sampleMd = await fetchText(
      sampleDoc.fetchUrl,
      context.signal,
      10_000,
    );
    const { cleanResult } = cleanQoderMdx(sampleMd, {
      baseUrl: sampleDoc.canonicalUrl,
    });
    if (cleanResult.text.trim().length === 0) {
      return {
        availability: "unavailable",
        scope: [CN_CHANGELOGS_SCOPE_ID],
        basis: `Sample changelog document ${sampleDoc.docKey} cleaned to empty content.`,
        problems: [
          {
            code: "qoder_cn_changelog_sample_empty",
            message: `Sample document ${sampleDoc.docKey} yielded empty clean content.`,
            impact: "Cannot synchronize Qoder CN product changelogs.",
            suggestion: "Verify document markup and MDX structure.",
            requiresHuman: false,
          },
        ],
      };
    }

    return {
      availability: "available",
      scope: [CN_CHANGELOGS_SCOPE_ID],
      basis: `Qoder CN changelog index is reachable with ${docs.length} products. Sample "${sampleDoc.title}" extracted successfully.`,
      problems: [],
    };
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [CN_CHANGELOGS_SCOPE_ID],
      basis: `Failed to check Qoder CN changelog index at ${indexUrl}: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "qoder_cn_changelogs_unreachable",
          message: error instanceof Error ? error.message : "Index unreachable",
          impact: "Cannot synchronize Qoder CN product changelogs.",
          suggestion: "Verify network connectivity and URL configuration.",
          requiresHuman: false,
        },
      ],
    };
  }
}

/** Checks Qoder International changelog index reachability and verifies extraction on 1 sample document. */
export async function checkInternationalChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderCheckOutput> {
  const indexUrl =
    context.config.intChangelogIndexUrl ?? DEFAULT_INTERNATIONAL_CHANGELOG_URL;
  try {
    const text = await fetchText(indexUrl, context.signal, 10_000);
    const docs = await discoverInternationalChangelogDocs(text, indexUrl, (u) =>
      fetchText(u, context.signal, 10_000),
    );

    if (docs.length === 0) {
      return {
        availability: "unavailable",
        scope: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
        basis: `Qoder International changelog index responded but contained no active changelog documents.`,
        problems: [
          {
            code: "qoder_int_changelogs_empty",
            message: "No product changelog documents discovered in index.",
            impact:
              "Cannot synchronize Qoder International product changelogs.",
            suggestion: "Verify that the index contains changelog entries.",
            requiresHuman: false,
          },
        ],
      };
    }

    const sampleDoc = docs[0]!;
    const sampleMd = await fetchText(
      sampleDoc.fetchUrl,
      context.signal,
      10_000,
    );
    const { cleanResult } = cleanQoderMdx(sampleMd, {
      baseUrl: sampleDoc.canonicalUrl,
    });
    if (cleanResult.text.trim().length === 0) {
      return {
        availability: "unavailable",
        scope: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
        basis: `Sample changelog document ${sampleDoc.docKey} cleaned to empty content.`,
        problems: [
          {
            code: "qoder_int_changelog_sample_empty",
            message: `Sample document ${sampleDoc.docKey} yielded empty clean content.`,
            impact:
              "Cannot synchronize Qoder International product changelogs.",
            suggestion: "Verify document markup and MDX structure.",
            requiresHuman: false,
          },
        ],
      };
    }

    return {
      availability: "available",
      scope: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      basis: `Qoder International changelog index is reachable with ${docs.length} products. Sample "${sampleDoc.title}" extracted successfully.`,
      problems: [],
    };
  } catch (error) {
    return {
      availability: "unavailable",
      scope: [INTERNATIONAL_CHANGELOGS_SCOPE_ID],
      basis: `Failed to check Qoder International changelog index at ${indexUrl}: ${error instanceof Error ? error.message : String(error)}`,
      problems: [
        {
          code: "qoder_int_changelogs_unreachable",
          message: error instanceof Error ? error.message : "Index unreachable",
          impact: "Cannot synchronize Qoder International product changelogs.",
          suggestion: "Verify network connectivity and URL configuration.",
          requiresHuman: false,
        },
      ],
    };
  }
}

/**
 * Incrementally synchronizes regional changelog documents using
 * ongoing-document whole-page revision semantics.
 */
async function syncRegionalChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
  isCn: boolean,
): Promise<QoderSyncOutput> {
  const scopeId = isCn
    ? CN_CHANGELOGS_SCOPE_ID
    : INTERNATIONAL_CHANGELOGS_SCOPE_ID;
  const indexUrl = isCn
    ? (context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL)
    : (context.config.intChangelogIndexUrl ??
      DEFAULT_INTERNATIONAL_CHANGELOG_URL);

  const state = await loadIncrementalSyncState(context);
  const indexText = await fetchText(indexUrl, context.signal);

  const activeDocs = isCn
    ? await discoverCnChangelogDocs(indexText, indexUrl, (u) =>
        fetchText(u, context.signal),
      )
    : await discoverInternationalChangelogDocs(indexText, indexUrl, (u) =>
        fetchText(u, context.signal),
      );

  const activeKeys = new Set(activeDocs.map((doc) => doc.docKey));
  const isInitialized = isIncrementalScopeInitialized(state, scopeId);

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
        if (isNavigationDocKey(doc.docKey) || isNavigationPageContent(rawMd)) {
          throw new Error(
            `Navigation overview page ${doc.docKey} cannot be archived as changelog body`,
          );
        }
        const { cleanResult } = cleanQoderMdx(rawMd, {
          baseUrl: doc.canonicalUrl,
        });
        if (cleanResult.text.trim().length === 0) {
          throw new Error(`Cleaned content is empty for ${doc.docKey}`);
        }
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
      throw failureFromProblems(scopeId, problems, []);
    }

    initializeIncrementalScope(state, scopeId, {
      scopeUrl: indexUrl,
      initializedAt: new Date().toISOString(),
      ongoingDocuments: baselineOngoingDocs,
    });
    await saveIncrementalSyncState(context, state);

    return {
      completedScopes: [scopeId],
      initializedScopes: [scopeId],
    };
  }

  // Subsequent sync:
  // 1. Prune pages that have exited the active changelogs list.
  pruneInactiveOngoingDocuments(state, scopeId, activeKeys);

  // 2. Check each currently active changelog page for in-place content changes.
  for (const doc of activeDocs) {
    if (context.signal.aborted) throw context.signal.reason;
    try {
      const rawMd = await fetchText(doc.fetchUrl, context.signal);
      if (isNavigationDocKey(doc.docKey) || isNavigationPageContent(rawMd)) {
        throw new Error(
          `Navigation overview page ${doc.docKey} cannot be archived as changelog body`,
        );
      }
      const { cleanResult, updates } = cleanQoderMdx(rawMd, {
        baseUrl: doc.canonicalUrl,
      });
      if (cleanResult.text.trim().length === 0) {
        throw new Error(`Cleaned content is empty for ${doc.docKey}`);
      }
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );

      const previous = getIncrementalScopeOngoingDocument(
        state,
        scopeId,
        doc.docKey,
      );

      if (hasOngoingDocumentChanged(previous, contentHash)) {
        const meta = parseChangelogMetadata(updates, cleanResult.markdown);
        const submitResult = await submitCleanedArticle(context, {
          sourceKey: {
            namespace: isCn
              ? "qoder:cn:changelog"
              : "qoder:international:changelog",
            key: doc.docKey,
          },
          sourceRef: doc.canonicalUrl,
          title:
            doc.title === doc.docKey
              ? extractQoderDocumentTitle(cleanResult.markdown)
              : doc.title,
          sourcePublishedAt: null,
          sourceModifiedAt: null,
          extensions: {
            region: isCn ? "cn" : "international",
            language: isCn ? "zh-CN" : "en",
            category: "changelog",
            ...(doc.description ? { summary: doc.description } : {}),
            ...(meta.latestUpdateLabel
              ? { latestUpdateLabel: meta.latestUpdateLabel }
              : {}),
            ...(meta.latestVersion
              ? { latestVersion: meta.latestVersion }
              : {}),
            ...(meta.latestUpdateDate
              ? { latestUpdateDate: meta.latestUpdateDate }
              : {}),
            ...(meta.latestUpdateDatePrecision
              ? { latestUpdateDatePrecision: meta.latestUpdateDatePrecision }
              : {}),
            ...(updates.length > 0
              ? { updates: updates.map((update) => ({ ...update })) }
              : {}),
          },
          cleanResult,
          captureScope: {
            scopeId,
            scopeUrl: indexUrl,
            documentKey: doc.docKey,
          },
        });

        upsertIncrementalScopeOngoingDocument(state, scopeId, doc.docKey, {
          contentHash,
        });
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
    throw failureFromProblems(scopeId, problems, hasFailures ? [] : [scopeId]);
  }

  await saveIncrementalSyncState(context, state);

  return {
    completedScopes: [scopeId],
  };
}

export function syncCnChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderSyncOutput> {
  return syncRegionalChangelogs(context, true);
}

export function syncInternationalChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
): Promise<QoderSyncOutput> {
  return syncRegionalChangelogs(context, false);
}

/** Collects regional changelog documents on demand. */
async function collectRegionalChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
  params: QoderCollectParams,
  isCn: boolean,
): Promise<QoderCollectOutput> {
  const scopeId = isCn
    ? CN_CHANGELOGS_SCOPE_ID
    : INTERNATIONAL_CHANGELOGS_SCOPE_ID;
  const indexUrl = isCn
    ? (context.config.cnDocsIndexUrl ?? DEFAULT_CN_DOCS_INDEX_URL)
    : (context.config.intChangelogIndexUrl ??
      DEFAULT_INTERNATIONAL_CHANGELOG_URL);

  const state = await loadIncrementalSyncState(context);
  let targetDocs: DiscoveredChangelogDoc[] = [];

  if (params.articleUrls && params.articleUrls.length > 0) {
    for (const url of params.articleUrls) {
      // If the URL clearly targets the other region, skip it for this scope
      if (isCn && /changelog\.qoder\.com/iu.test(url)) {
        continue;
      }
      if (!isCn && /(?:docs|changelog)\.qoder\.cn/iu.test(url)) {
        continue;
      }

      const docKey = extractDocKey(url);
      if (docKey.length > 0) {
        if (isNavigationDocKey(docKey)) {
          throw sourceAdapterActionError(
            {
              code: "qoder_navigation_page_not_archivable",
              message: `Navigation overview page ${docKey} cannot be archived as a changelog document`,
              impact: "Collection rejected navigation page.",
              suggestion:
                "Specify a product changelog URL instead of a navigation overview.",
              requiresHuman: false,
            },
            [],
          );
        }
        const itemBaseUrl =
          isCn && /changelog\.qoder\.cn/iu.test(url)
            ? DEFAULT_CN_CHANGELOG_URL
            : indexUrl;

        targetDocs.push({
          title: docKey,
          docKey,
          canonicalUrl: buildCanonicalDocUrl(docKey, itemBaseUrl),
          fetchUrl: buildFetchMdUrl(url, itemBaseUrl),
          section: isCn ? "更新日志" : "Changelog",
        });
      }
    }
  } else {
    const indexText = await fetchText(indexUrl, context.signal);
    const discovered = isCn
      ? await discoverCnChangelogDocs(indexText, indexUrl, (u) =>
          fetchText(u, context.signal),
        )
      : await discoverInternationalChangelogDocs(indexText, indexUrl, (u) =>
          fetchText(u, context.signal),
        );

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
      if (isNavigationDocKey(doc.docKey) || isNavigationPageContent(rawMd)) {
        throw new Error(
          `Navigation overview page ${doc.docKey} cannot be archived as changelog body`,
        );
      }
      const { cleanResult, updates } = cleanQoderMdx(rawMd, {
        baseUrl: doc.canonicalUrl,
      });
      if (cleanResult.text.trim().length === 0) {
        throw new Error(`Cleaned content is empty for ${doc.docKey}`);
      }
      const contentHash = computeOngoingDocumentHash(
        cleanResult.markdown,
        cleanResult.text,
      );
      const meta = parseChangelogMetadata(updates, cleanResult.markdown);

      const submitResult = await submitCleanedArticle(context, {
        sourceKey: {
          namespace: isCn
            ? "qoder:cn:changelog"
            : "qoder:international:changelog",
          key: doc.docKey,
        },
        sourceRef: doc.canonicalUrl,
        title:
          doc.title === doc.docKey
            ? extractQoderDocumentTitle(cleanResult.markdown)
            : doc.title,
        sourcePublishedAt: null,
        sourceModifiedAt: null,
        extensions: {
          region: isCn ? "cn" : "international",
          language: isCn ? "zh-CN" : "en",
          category: "changelog",
          ...(doc.description ? { summary: doc.description } : {}),
          ...(meta.latestUpdateLabel
            ? { latestUpdateLabel: meta.latestUpdateLabel }
            : {}),
          ...(meta.latestVersion ? { latestVersion: meta.latestVersion } : {}),
          ...(meta.latestUpdateDate
            ? { latestUpdateDate: meta.latestUpdateDate }
            : {}),
          ...(meta.latestUpdateDatePrecision
            ? { latestUpdateDatePrecision: meta.latestUpdateDatePrecision }
            : {}),
          ...(updates.length > 0
            ? { updates: updates.map((update) => ({ ...update })) }
            : {}),
        },
        cleanResult,
        captureScope: {
          scopeId,
          scopeUrl: indexUrl,
          documentKey: doc.docKey,
        },
      });

      upsertIncrementalScopeOngoingDocument(state, scopeId, doc.docKey, {
        contentHash,
      });
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
    throw failureFromProblems(scopeId, problems, hasFailures ? [] : [scopeId]);
  }

  await saveIncrementalSyncState(context, state);

  return {
    completedScopes: [scopeId],
  };
}

export function collectCnChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
  params: QoderCollectParams,
): Promise<QoderCollectOutput> {
  return collectRegionalChangelogs(context, params, true);
}

export function collectInternationalChangelogs(
  context: SourceAdapterContext<QoderConfig, never, QoderExtensions>,
  params: QoderCollectParams,
): Promise<QoderCollectOutput> {
  return collectRegionalChangelogs(context, params, false);
}
