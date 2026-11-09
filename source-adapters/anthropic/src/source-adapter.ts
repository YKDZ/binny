// Anthropic source adapter implementation for News, Research, and Engineering.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  hasIncrementalEntryChanged,
  incrementalSyncStateSchema,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  sourceTimeFrom,
  submitCleanedArticle,
  upsertIncrementalScopeEntry,
  type IncrementalEntryRecord,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

import {
  computeArticleFingerprint,
  discoverSectionArticles,
  normalizeCanonicalPath,
  parseSitemap,
} from "./discovery.ts";
import { extractArticleContent } from "./extractor.ts";
import type { CandidateArticle } from "./types.ts";

const sectionDefinitionSchema = z
  .object({
    id: z.enum(["news", "research", "engineering"]).or(z.string().min(1)),
    url: z.string().url(),
  })
  .strict();

export const defaultSections = [
  { id: "news", url: "https://www.anthropic.com/news" },
  { id: "research", url: "https://www.anthropic.com/research" },
  { id: "engineering", url: "https://www.anthropic.com/engineering" },
];

export const configSchema = z
  .object({
    sections: z.array(sectionDefinitionSchema).default(defaultSections),
    sitemapUrl: z.string().url().optional(),
  })
  .strict();

export type AnthropicConfig = z.output<typeof configSchema>;

const extensionsSchema = z
  .object({
    canonicalPath: z
      .string()
      .describe("Canonical path identifying this Anthropic page."),
    sections: z
      .array(z.string())
      .describe("Anthropic publication sections containing this page."),
    category: z
      .string()
      .optional()
      .describe("Category label shown for this page in an Anthropic listing."),
    sitemapLastMod: z
      .string()
      .optional()
      .describe(
        "Last-modified value declared for this page in the sitemap; it is discovery evidence and may not represent a verified article edit.",
      ),
  })
  .strict();

type AnthropicExtensions = z.output<typeof extensionsSchema>;

export const paramsSchema = z
  .object({
    sectionIds: z.array(z.enum(["news", "research", "engineering"])).optional(),
    itemUrls: z.array(z.string().url()).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict();

export type AnthropicParams = z.output<typeof paramsSchema>;

const checkProblemSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    impact: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    suggestion: z.string().min(1),
    requiresHuman: z.boolean(),
  })
  .strict();

export const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string().min(1),
    problems: z.array(checkProblemSchema),
  })
  .strict();

export const collectOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
  })
  .strict();

export const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

interface ProblemItem {
  readonly sectionId?: string | undefined;
  readonly message: string;
  readonly path?: readonly (string | number)[] | undefined;
  readonly suggestion?: string | undefined;
}

function failureFromProblems(
  problems: readonly ProblemItem[],
  completedScopes: readonly string[],
) {
  const examples = problems
    .slice(0, 8)
    .map((p) => (p.sectionId ? `${p.sectionId}: ${p.message}` : p.message));
  const more =
    problems.length > examples.length
      ? `; and ${problems.length - examples.length} more issues`
      : "";
  const completed =
    completedScopes.length === 0
      ? ""
      : `Completed scopes retained: ${completedScopes.join(", ")}. `;
  return sourceAdapterActionError(
    {
      code: "anthropic_collection_incomplete",
      message: `Anthropic collection failed: ${examples.join("; ")}${more}`,
      impact: `${completed}Submitted material remains in archive; failed scopes were not advanced.`,
      suggestion: "Check network reachability and Anthropic page structure.",
      requiresHuman: false,
    },
    completedScopes,
  );
}

function resolveSelectedSections(
  config: AnthropicConfig,
  params: AnthropicParams,
): {
  readonly selected: readonly { readonly id: string; readonly url: string }[];
  readonly missing: readonly string[];
} {
  if (!params.sectionIds || params.sectionIds.length === 0) {
    return { selected: config.sections, missing: [] };
  }

  const byId = new Map(config.sections.map((s) => [s.id, s]));
  const selected: { id: string; url: string }[] = [];
  const missing: string[] = [];

  for (const id of params.sectionIds) {
    const found = byId.get(id);
    if (found) {
      selected.push(found);
    } else {
      missing.push(id);
    }
  }

  return { selected, missing };
}

async function fetchHtml(
  url: string,
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "user-agent": "Binny AnthropicAdapter/1.0",
    },
    signal,
  });

  const body = response.status === 200 ? await response.text() : "";
  return { status: response.status, body };
}

/** Action: check section reachability and sample article extraction. */
async function checkAnthropic(
  context: SourceAdapterContext<AnthropicConfig, never, AnthropicExtensions>,
  params: AnthropicParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const { selected, missing } = resolveSelectedSections(context.config, params);
  const problems: z.infer<typeof checkProblemSchema>[] = [];

  for (const miss of missing) {
    problems.push({
      code: "anthropic_section_not_configured",
      message: `Requested section "${miss}" is not configured.`,
      impact: "Cannot check unconfigured section.",
      path: ["sectionIds", miss],
      suggestion: "Configure the section in source adapter configuration.",
      requiresHuman: false,
    });
  }

  let sampleArticleUrl: string | undefined;
  let sampleArticleCardDate: string | undefined;
  let sampleArticleTitle: string | undefined;

  for (const section of selected) {
    if (context.signal.aborted) throw context.signal.reason;

    try {
      const { status, body } = await fetchHtml(section.url, context.signal);
      if (status !== 200) {
        problems.push({
          code: "anthropic_section_unavailable",
          message: `Section "${section.id}" returned HTTP ${status}.`,
          impact: `Section "${section.id}" is unreachable.`,
          path: ["sections", section.id],
          suggestion: "Verify Anthropic section URL and network connectivity.",
          requiresHuman: false,
        });
        continue;
      }

      const discovered = discoverSectionArticles(body, section.id, section.url);
      if (discovered.length === 0) {
        problems.push({
          code: "anthropic_no_articles_discovered",
          message: `No article cards discovered in section "${section.id}".`,
          impact: `Section "${section.id}" list format may have changed.`,
          path: ["sections", section.id],
          suggestion:
            "Inspect section HTML layout for changes in card structure.",
          requiresHuman: false,
        });
      } else if (!sampleArticleUrl && discovered[0]) {
        sampleArticleUrl = discovered[0].url;
        sampleArticleCardDate = discovered[0].cardDate;
        sampleArticleTitle = discovered[0].title;
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        code: "anthropic_section_fetch_failed",
        message: `Failed to fetch section "${section.id}": ${error instanceof Error ? error.message : String(error)}`,
        impact: `Section "${section.id}" is unavailable.`,
        path: ["sections", section.id],
        suggestion: "Check network connectivity and Anthropic server status.",
        requiresHuman: false,
      });
    }
  }

  // Validate detail extraction on sample article if available
  if (sampleArticleUrl) {
    try {
      const { status, body } = await fetchHtml(
        sampleArticleUrl,
        context.signal,
      );
      if (status !== 200) {
        problems.push({
          code: "anthropic_sample_article_unavailable",
          message: `Sample article at "${sampleArticleUrl}" returned HTTP ${status}.`,
          impact: "Sample article extraction failed.",
          path: ["sampleArticle", sampleArticleUrl],
          suggestion: "Verify article URL reachability.",
          requiresHuman: false,
        });
      } else {
        const extracted = extractArticleContent(
          body,
          sampleArticleUrl,
          sampleArticleCardDate,
          sampleArticleTitle,
        );
        if (!extracted.ok) {
          problems.push({
            code: "anthropic_sample_extraction_failed",
            message: extracted.reason,
            impact: "Article content cannot be cleanly extracted.",
            path: ["sampleArticle", sampleArticleUrl],
            suggestion: "Verify detail page DOM layout and extraction rules.",
            requiresHuman: false,
          });
        }
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      problems.push({
        code: "anthropic_sample_fetch_error",
        message: `Failed to fetch sample article at "${sampleArticleUrl}": ${error instanceof Error ? error.message : String(error)}`,
        impact: "Sample article verification failed.",
        path: ["sampleArticle", sampleArticleUrl],
        suggestion: "Check network connectivity.",
        requiresHuman: false,
      });
    }
  }

  const availability =
    problems.length === 0
      ? ("available" as const)
      : problems.some((p) => p.code.includes("unavailable"))
        ? ("unavailable" as const)
        : ("unknown" as const);

  return {
    availability,
    scope: selected.map((s) => `section:${s.id}`),
    basis:
      "Checked Anthropic section list reachability, article discovery, and sample article extraction.",
    problems,
  };
}

/** Action: incremental sync of Anthropic sections. */
async function syncAnthropic(
  context: SourceAdapterContext<AnthropicConfig, never, AnthropicExtensions>,
  params: AnthropicParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const { selected, missing } = resolveSelectedSections(context.config, params);
  const problems: ProblemItem[] = missing.map((miss) => ({
    sectionId: miss,
    message: `Requested section "${miss}" is not configured.`,
    path: ["sectionIds", miss],
  }));

  const state = await loadIncrementalSyncState(context);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const failedSections = new Set<string>();

  // Map candidate articles across sections by canonicalPath
  const candidatesMap = new Map<string, CandidateArticle>();

  for (const section of selected) {
    if (context.signal.aborted) throw context.signal.reason;

    let html: string;
    try {
      const res = await fetchHtml(section.url, context.signal);
      if (res.status !== 200) {
        failedSections.add(section.id);
        problems.push({
          sectionId: section.id,
          message: `Section list returned HTTP ${res.status}.`,
          path: ["sections", section.id],
        });
        continue;
      }
      html = res.body;
    } catch (error) {
      if (context.signal.aborted) throw error;
      failedSections.add(section.id);
      problems.push({
        sectionId: section.id,
        message: `Section request failed: ${error instanceof Error ? error.message : String(error)}`,
        path: ["sections", section.id],
      });
      continue;
    }

    const discovered = discoverSectionArticles(html, section.id, section.url);

    const isInitialized = isIncrementalScopeInitialized(
      state,
      section.id,
      section.url,
    );

    if (!isInitialized) {
      // First sync on uninitialized scope: record baseline entries WITHOUT detail fetching
      const baselineEntries: Record<string, IncrementalEntryRecord> = {};
      for (const item of discovered) {
        const fingerprint = computeArticleFingerprint(
          item.title,
          item.cardDate,
        );
        baselineEntries[item.canonicalPath] = {
          fingerprint,
          ...(item.cardDate ? { publishedAt: item.cardDate } : {}),
          archivedCompleteness: "baseline",
        };
      }

      initializeIncrementalScope(state, section.id, {
        scopeUrl: section.url,
        initializedAt: context.referenceTime,
        entries: baselineEntries,
      });

      initializedScopes.push(section.id);
      completedScopes.push(`section:${section.id}`);
      continue;
    }

    // Initialized scope: detect new or modified articles
    const scopeState = state.scopes[section.id];
    for (const item of discovered) {
      const prevEntry = scopeState?.entries[item.canonicalPath];
      const fingerprint = computeArticleFingerprint(item.title, item.cardDate);

      const changed = hasIncrementalEntryChanged(
        prevEntry,
        fingerprint,
        prevEntry?.updatedAt,
      );

      if (changed) {
        const existing = candidatesMap.get(item.canonicalPath);
        if (existing === undefined) {
          candidatesMap.set(item.canonicalPath, {
            canonicalPath: item.canonicalPath,
            url: item.url,
            title: item.title,
            cardDate: item.cardDate,
            category: item.category,
            sections: new Set([section.id]),
            fingerprint,
          });
        } else {
          existing.sections.add(section.id);
        }
      }
    }
  }

  // If candidate articles exist and sitemap is configured, fetch optional lastmod signals
  let sitemapLastModMap: Map<string, string> | undefined;
  if (candidatesMap.size > 0 && context.config.sitemapUrl) {
    try {
      const sitemapRes = await fetchHtml(
        context.config.sitemapUrl,
        context.signal,
      );
      if (sitemapRes.status === 200) {
        sitemapLastModMap = parseSitemap(sitemapRes.body);
      }
    } catch {
      // Optional sitemap fetch failure does not stop article collection
    }
  }

  // Fetch detail pages and archive candidates (fetching each unique article only once)
  for (const candidate of candidatesMap.values()) {
    if (context.signal.aborted) throw context.signal.reason;

    const sitemapLastMod =
      sitemapLastModMap?.get(candidate.url) ??
      sitemapLastModMap?.get(candidate.canonicalPath);

    let detailHtml: string;
    try {
      const res = await fetchHtml(candidate.url, context.signal);
      if (res.status !== 200) {
        for (const sec of candidate.sections) {
          failedSections.add(sec);
        }
        problems.push({
          message: `Article detail at "${candidate.url}" returned HTTP ${res.status}.`,
          path: ["articles", candidate.canonicalPath],
        });
        continue;
      }
      detailHtml = res.body;
    } catch (error) {
      if (context.signal.aborted) throw error;
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: `Failed to fetch article detail at "${candidate.url}": ${error instanceof Error ? error.message : String(error)}`,
        path: ["articles", candidate.canonicalPath],
      });
      continue;
    }

    const extraction = extractArticleContent(
      detailHtml,
      candidate.url,
      candidate.cardDate,
      candidate.title,
    );

    if (!extraction.ok) {
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: extraction.reason,
        path: ["articles", candidate.canonicalPath],
      });
      continue;
    }

    const { article } = extraction;
    const sections = Array.from(candidate.sections).sort();

    try {
      const archiveResult = await submitCleanedArticle(context, {
        sourceKey: {
          namespace: "anthropic:article",
          key: candidate.canonicalPath,
        },
        sourceRef: candidate.url,
        title: article.title || null,
        sourcePublishedAt: sourceTimeFrom(
          article.publishedAt ?? article.publishedDate,
        ),
        sourceModifiedAt: sourceTimeFrom(article.sourceModifiedAt),
        extensions: {
          canonicalPath: candidate.canonicalPath,
          sections,
          ...(candidate.category === undefined
            ? {}
            : { category: candidate.category }),
          ...(sitemapLastMod === undefined ? {} : { sitemapLastMod }),
        },
        cleanResult: article.cleanResult,
        captureScope: {
          source: "anthropic",
          canonicalPath: candidate.canonicalPath,
          sections,
        },
      });

      // Update state entry in each section that shares this article
      const entryRecord: IncrementalEntryRecord = {
        fingerprint: candidate.fingerprint,
        ...(article.sourceModifiedAt
          ? { updatedAt: article.sourceModifiedAt }
          : sitemapLastMod
            ? { updatedAt: sitemapLastMod }
            : {}),
        ...(article.publishedAt
          ? { publishedAt: article.publishedAt }
          : article.publishedDate
            ? { publishedAt: article.publishedDate }
            : {}),
        archivedCompleteness: archiveResult.hasMediaFailures
          ? "partial"
          : "complete",
      };

      for (const secId of candidate.sections) {
        upsertIncrementalScopeEntry(
          state,
          secId,
          candidate.canonicalPath,
          entryRecord,
        );
      }
    } catch (error) {
      if (context.signal.aborted) throw error;
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: `Failed to submit article "${candidate.canonicalPath}": ${error instanceof Error ? error.message : String(error)}`,
        path: ["articles", candidate.canonicalPath],
      });
    }
  }

  // Add initialized sections that completed without errors
  for (const section of selected) {
    const scopeId = `section:${section.id}`;
    if (!failedSections.has(section.id) && !completedScopes.includes(scopeId)) {
      completedScopes.push(scopeId);
    }
  }

  await saveIncrementalSyncState(context, state);

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return { completedScopes, initializedScopes };
}

/** Action: collect articles explicitly or from section lists. */
async function collectAnthropic(
  context: SourceAdapterContext<AnthropicConfig, never, AnthropicExtensions>,
  params: AnthropicParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const problems: ProblemItem[] = [];
  const completedScopes: string[] = [];
  const failedSections = new Set<string>();

  // If itemUrls is provided, collect those specific items
  if (params.itemUrls && params.itemUrls.length > 0) {
    const state = context.persistentState
      ? await loadIncrementalSyncState(context).catch(() => undefined)
      : undefined;

    const deduplicatedUrls = Array.from(new Set(params.itemUrls));
    for (const url of deduplicatedUrls) {
      if (context.signal.aborted) throw context.signal.reason;

      const canonicalPath =
        normalizeCanonicalPath(url, url) ?? new URL(url).pathname;

      let cardDate: string | undefined;
      for (const scope of Object.values(state?.scopes ?? {})) {
        const entry = scope.entries[canonicalPath];
        if (entry?.publishedAt) {
          cardDate = entry.publishedAt;
          break;
        }
      }

      let detailHtml: string;
      try {
        const res = await fetchHtml(url, context.signal);
        if (res.status !== 200) {
          problems.push({
            message: `Article detail at "${url}" returned HTTP ${res.status}.`,
            path: ["itemUrls", url],
          });
          continue;
        }
        detailHtml = res.body;
      } catch (error) {
        if (context.signal.aborted) throw error;
        problems.push({
          message: `Failed to fetch article detail at "${url}": ${error instanceof Error ? error.message : String(error)}`,
          path: ["itemUrls", url],
        });
        continue;
      }

      const extraction = extractArticleContent(detailHtml, url, cardDate);
      if (!extraction.ok) {
        problems.push({
          message: extraction.reason,
          path: ["itemUrls", url],
        });
        continue;
      }

      const { article } = extraction;
      try {
        await submitCleanedArticle(context, {
          sourceKey: {
            namespace: "anthropic:article",
            key: canonicalPath,
          },
          sourceRef: url,
          title: article.title || null,
          sourcePublishedAt: sourceTimeFrom(
            article.publishedAt ?? article.publishedDate,
          ),
          sourceModifiedAt: sourceTimeFrom(article.sourceModifiedAt),
          extensions: {
            canonicalPath,
            sections: [],
          },
          cleanResult: article.cleanResult,
          captureScope: {
            source: "anthropic",
            canonicalPath,
          },
        });
        completedScopes.push(`item:${canonicalPath}`);
      } catch (error) {
        if (context.signal.aborted) throw error;
        problems.push({
          message: `Failed to submit article "${canonicalPath}": ${error instanceof Error ? error.message : String(error)}`,
          path: ["itemUrls", url],
        });
      }
    }

    if (problems.length > 0) {
      throw failureFromProblems(problems, completedScopes);
    }
    return { completedScopes };
  }

  // Otherwise collect from section list pages
  const { selected, missing } = resolveSelectedSections(context.config, params);
  for (const miss of missing) {
    problems.push({
      sectionId: miss,
      message: `Requested section "${miss}" is not configured.`,
      path: ["sectionIds", miss],
    });
  }

  const candidatesMap = new Map<string, CandidateArticle>();

  for (const section of selected) {
    if (context.signal.aborted) throw context.signal.reason;

    let html: string;
    try {
      const res = await fetchHtml(section.url, context.signal);
      if (res.status !== 200) {
        failedSections.add(section.id);
        problems.push({
          sectionId: section.id,
          message: `Section list returned HTTP ${res.status}.`,
          path: ["sections", section.id],
        });
        continue;
      }
      html = res.body;
    } catch (error) {
      if (context.signal.aborted) throw error;
      failedSections.add(section.id);
      problems.push({
        sectionId: section.id,
        message: `Section request failed: ${error instanceof Error ? error.message : String(error)}`,
        path: ["sections", section.id],
      });
      continue;
    }

    const discovered = discoverSectionArticles(html, section.id, section.url);

    const targetArticles =
      params.maxItems !== undefined
        ? discovered.slice(0, params.maxItems)
        : discovered;

    for (const item of targetArticles) {
      const existing = candidatesMap.get(item.canonicalPath);
      const fingerprint = computeArticleFingerprint(item.title, item.cardDate);
      if (existing === undefined) {
        candidatesMap.set(item.canonicalPath, {
          canonicalPath: item.canonicalPath,
          url: item.url,
          title: item.title,
          cardDate: item.cardDate,
          category: item.category,
          sections: new Set([section.id]),
          fingerprint,
        });
      } else {
        existing.sections.add(section.id);
      }
    }
  }

  for (const candidate of candidatesMap.values()) {
    if (context.signal.aborted) throw context.signal.reason;

    let detailHtml: string;
    try {
      const res = await fetchHtml(candidate.url, context.signal);
      if (res.status !== 200) {
        for (const sec of candidate.sections) {
          failedSections.add(sec);
        }
        problems.push({
          message: `Article detail at "${candidate.url}" returned HTTP ${res.status}.`,
          path: ["articles", candidate.canonicalPath],
        });
        continue;
      }
      detailHtml = res.body;
    } catch (error) {
      if (context.signal.aborted) throw error;
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: `Failed to fetch article detail at "${candidate.url}": ${error instanceof Error ? error.message : String(error)}`,
        path: ["articles", candidate.canonicalPath],
      });
      continue;
    }

    const extraction = extractArticleContent(
      detailHtml,
      candidate.url,
      candidate.cardDate,
      candidate.title,
    );

    if (!extraction.ok) {
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: extraction.reason,
        path: ["articles", candidate.canonicalPath],
      });
      continue;
    }

    const { article } = extraction;
    const sections = Array.from(candidate.sections).sort();

    try {
      await submitCleanedArticle(context, {
        sourceKey: {
          namespace: "anthropic:article",
          key: candidate.canonicalPath,
        },
        sourceRef: candidate.url,
        title: article.title || null,
        sourcePublishedAt: sourceTimeFrom(
          article.publishedAt ?? article.publishedDate,
        ),
        sourceModifiedAt: sourceTimeFrom(article.sourceModifiedAt),
        extensions: {
          canonicalPath: candidate.canonicalPath,
          sections,
          ...(candidate.category === undefined
            ? {}
            : { category: candidate.category }),
        },
        cleanResult: article.cleanResult,
        captureScope: {
          source: "anthropic",
          canonicalPath: candidate.canonicalPath,
          sections,
        },
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      for (const sec of candidate.sections) {
        failedSections.add(sec);
      }
      problems.push({
        message: `Failed to submit article "${candidate.canonicalPath}": ${error instanceof Error ? error.message : String(error)}`,
        path: ["articles", candidate.canonicalPath],
      });
    }
  }

  for (const section of selected) {
    if (!failedSections.has(section.id)) {
      completedScopes.push(`section:${section.id}`);
    }
  }

  if (problems.length > 0) {
    throw failureFromProblems(problems, completedScopes);
  }

  return { completedScopes };
}

export const sourceAdapter = defineSourceAdapter({
  id: "anthropic",
  version: "0.1.0",
  description: "Anthropic News, Research, and Engineering source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Check Anthropic sections reachability and detail extraction.",
      params: paramsSchema,
      output: checkOutputSchema,
      execute: checkAnthropic,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Collect articles from Anthropic sections or specific URLs.",
      params: paramsSchema,
      output: collectOutputSchema,
      execute: collectAnthropic,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Incrementally synchronize new or modified Anthropic articles.",
      params: paramsSchema,
      output: syncOutputSchema,
      execute: syncAnthropic,
    }),
  },
});
