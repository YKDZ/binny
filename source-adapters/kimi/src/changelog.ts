// Kimi platform changelog fetching, date extraction, and sync/collect actions.
import {
  cleanContent,
  computeOngoingDocumentHash,
  getIncrementalScopeOngoingDocument,
  hasOngoingDocumentChanged,
  initializeIncrementalScope,
  isIncrementalScopeInitialized,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  submitCleanedArticle,
  updateIncrementalScopeValidators,
  upsertIncrementalScopeOngoingDocument,
  type CleanContentResult,
  type IncrementalSyncState,
  type JsonObject,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { z } from "zod";

export const kimiRegionSchema = z.enum(["cn", "international"]);
export type KimiRegion = z.infer<typeof kimiRegionSchema>;

export const kimiSourceDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1, "信源稳定标识不能为空。")
      .max(128, "信源稳定标识不能超过 128 个字符。")
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u,
        "信源稳定标识只能包含字母、数字、点、下划线和连字符。",
      ),
    kind: z.enum(["changelog", "research"]).default("changelog"),
    region: kimiRegionSchema,
    language: z.string().min(1).max(32),
    url: z.string().url("信源地址必须是有效 URL。"),
    title: z.string().min(1).max(512).optional(),
  })
  .strict();

export type KimiSourceDefinition = z.infer<typeof kimiSourceDefinitionSchema>;

export const DEFAULT_KIMI_CHANGELOG_SOURCES: readonly KimiSourceDefinition[] = [
  {
    id: "cn-platform-changelog",
    kind: "changelog",
    region: "cn",
    language: "zh-CN",
    url: "https://platform.kimi.com/docs/changelog/index.md",
    title: "Kimi 开放平台更新日志",
  },
  {
    id: "int-platform-changelog",
    kind: "changelog",
    region: "international",
    language: "en",
    url: "https://platform.kimi.ai/docs/platform-changelog.md",
    title: "Moonshot AI Platform Changelog",
  },
  {
    id: "cn-hosted-agents-changelog",
    kind: "changelog",
    region: "cn",
    language: "zh-CN",
    url: "https://platform.kimi.com/docs/hosted-agents/changelog.md",
    title: "Kimi Hosted Agents 更新日志",
  },
];

export const DEFAULT_KIMI_RESEARCH_SOURCES: readonly KimiSourceDefinition[] = [
  {
    id: "cn-research-zh",
    kind: "research",
    region: "cn",
    language: "zh-CN",
    url: "https://www.kimi.com/blog",
    title: "Kimi 研究博客（中文）",
  },
  {
    id: "cn-research-en",
    kind: "research",
    region: "cn",
    language: "en",
    url: "https://www.kimi.com/en/blog",
    title: "Kimi Research Blog (CN English)",
  },
  {
    id: "int-research",
    kind: "research",
    region: "international",
    language: "en",
    url: "https://www.kimi.ai/blog",
    title: "Moonshot AI Research Blog",
  },
];

export const DEFAULT_KIMI_SOURCES: readonly KimiSourceDefinition[] = [
  ...DEFAULT_KIMI_CHANGELOG_SOURCES,
  ...DEFAULT_KIMI_RESEARCH_SOURCES,
];

export const configSchema = z
  .object({
    sources: z
      .array(kimiSourceDefinitionSchema)
      .default(() => [...DEFAULT_KIMI_SOURCES]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    for (const [index, source] of config.sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: "同一配置不能重复使用信源稳定标识。",
        });
      }
      seen.add(source.id);
    }
  });

export type KimiConfig = z.infer<typeof configSchema>;

export const actionParamsSchema = z
  .object({
    sourceIds: z.array(z.string().min(1)).max(64).optional(),
    itemUrls: z.array(z.string().url()).optional(),
    maxItems: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((params, context) => {
    const seen = new Set<string>();
    for (const [index, id] of (params.sourceIds ?? []).entries()) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["sourceIds", index],
          message: "本次运行参数不能重复选择同一个信源。",
        });
      }
      seen.add(id);
    }
  });

export type ActionParams = z.infer<typeof actionParamsSchema>;

export const checkOutputSchema = z
  .object({
    availability: z.enum(["available", "unavailable", "unknown"]),
    scope: z.array(z.string()),
    basis: z.string().min(1),
    problems: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          impact: z.string().min(1),
          path: z.array(z.union([z.string(), z.number()])).optional(),
          suggestion: z.string().min(1),
          requiresHuman: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const collectOutputSchema = z
  .object({ completedScopes: z.array(z.string()).readonly() })
  .strict();

export const syncOutputSchema = z
  .object({
    completedScopes: z.array(z.string()).readonly(),
    initializedScopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

export function selectedSources(
  config: KimiConfig,
  params: ActionParams,
): {
  readonly sources: readonly KimiSourceDefinition[];
  readonly missing: readonly string[];
} {
  if (params.sourceIds === undefined) {
    return { sources: config.sources, missing: [] };
  }
  const byId = new Map(config.sources.map((s) => [s.id, s]));
  const sources: KimiSourceDefinition[] = [];
  const missing: string[] = [];
  for (const id of params.sourceIds) {
    const found = byId.get(id);
    if (found === undefined) {
      missing.push(id);
    } else {
      sources.push(found);
    }
  }
  return { sources, missing };
}

export function buildChangelogSourceKey(source: KimiSourceDefinition): {
  readonly namespace: string;
  readonly key: string;
} {
  return {
    namespace: `kimi:${source.region}`,
    key: `changelog:${source.id}`,
  };
}

export const MONTH_NAMES: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

export type ExtractedChangelogDates = {
  readonly latestDate?: string | undefined;
  readonly datePrecision?: "month" | "day" | undefined;
  readonly observedDates: readonly string[];
};

/** Extracts date facts from headings in markdown content without fabricating timestamps or days. */
export function extractChangelogDates(
  markdown: string,
): ExtractedChangelogDates {
  const lines = markdown.split("\n");
  const headingLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (/^#{1,6}\s+/u.test(trimmed)) {
      headingLines.push(trimmed.replace(/^#{1,6}\s+/u, "").trim());
    }
  }

  const observed: { date: string; precision: "month" | "day" }[] = [];

  for (const heading of headingLines) {
    // 1. Day precision checks
    // 1a: YYYY-MM-DD
    const isoDayMatch = heading.match(
      /(?:^|\D)(20\d\d)-(\d{1,2})-(\d{1,2})(?:$|\D)/u,
    );
    if (isoDayMatch?.[1] && isoDayMatch[2] && isoDayMatch[3]) {
      const y = isoDayMatch[1];
      const m = isoDayMatch[2].padStart(2, "0");
      const d = isoDayMatch[3].padStart(2, "0");
      observed.push({ date: `${y}-${m}-${d}`, precision: "day" });
      continue;
    }

    // 1b: YYYY年MM月DD日
    const cnDayMatch = heading.match(
      /(?:^|\D)(20\d\d)年(\d{1,2})月(\d{1,2})日?(?:$|\D)/u,
    );
    if (cnDayMatch?.[1] && cnDayMatch[2] && cnDayMatch[3]) {
      const y = cnDayMatch[1];
      const m = cnDayMatch[2].padStart(2, "0");
      const d = cnDayMatch[3].padStart(2, "0");
      observed.push({ date: `${y}-${m}-${d}`, precision: "day" });
      continue;
    }

    // 1c: Month DD, YYYY
    const enDayMatch = heading.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/iu,
    );
    if (enDayMatch?.[1] && enDayMatch[2] && enDayMatch[3]) {
      const monthStr = MONTH_NAMES[enDayMatch[1].toLowerCase()];
      const d = enDayMatch[2].padStart(2, "0");
      const y = enDayMatch[3];
      if (monthStr !== undefined) {
        observed.push({ date: `${y}-${monthStr}-${d}`, precision: "day" });
        continue;
      }
    }

    // 2. Month precision checks
    // 2a: YYYY年MM月
    const cnMonthMatch = heading.match(
      /(?:^|\D)(20\d\d)年(\d{1,2})月(?:$|\D)/u,
    );
    if (cnMonthMatch?.[1] && cnMonthMatch[2]) {
      const y = cnMonthMatch[1];
      const m = cnMonthMatch[2].padStart(2, "0");
      observed.push({ date: `${y}-${m}`, precision: "month" });
      continue;
    }

    // 2b: Month YYYY (e.g. "October 2026")
    const enMonthMatch = heading.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d\d)\b/iu,
    );
    if (enMonthMatch?.[1] && enMonthMatch[2]) {
      const monthStr = MONTH_NAMES[enMonthMatch[1].toLowerCase()];
      const y = enMonthMatch[2];
      if (monthStr !== undefined) {
        observed.push({ date: `${y}-${monthStr}`, precision: "month" });
        continue;
      }
    }

    // 2c: YYYY-MM
    const isoMonthMatch = heading.match(
      /(?:^|\D)(20\d\d)-(\d{1,2})(?:$|[^\d-])/u,
    );
    if (isoMonthMatch?.[1] && isoMonthMatch[2]) {
      const y = isoMonthMatch[1];
      const m = isoMonthMatch[2].padStart(2, "0");
      observed.push({ date: `${y}-${m}`, precision: "month" });
      continue;
    }
  }

  if (observed.length === 0) {
    return { observedDates: [] };
  }

  const uniqueDates: string[] = [];
  const seen = new Set<string>();
  for (const item of observed) {
    if (!seen.has(item.date)) {
      seen.add(item.date);
      uniqueDates.push(item.date);
    }
  }

  const hasDay = observed.some((o) => o.precision === "day");
  const datePrecision = hasDay ? "day" : "month";
  const sorted = [...uniqueDates].sort((a, b) => b.localeCompare(a));
  const latestDate = sorted[0];

  return {
    ...(latestDate !== undefined ? { latestDate } : {}),
    datePrecision,
    observedDates: uniqueDates,
  };
}

/** Preprocesses raw markdown to remove frontmatter, HTML comments, and convert inline markdown images outside code blocks to <img> tags. */
export function preprocessMarkdown(raw: string): string {
  let content = raw;
  if (content.startsWith("---")) {
    const endMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
    if (endMatch) {
      content = content.slice(endMatch[0].length);
    }
  }
  content = content.replaceAll(/<!--[\s\S]*?-->/gu, "");

  const lines = content.split("\n");
  let inCodeBlock = false;
  const resultLines: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      resultLines.push(line);
      continue;
    }
    if (inCodeBlock) {
      resultLines.push(line);
      continue;
    }
    const replaced = line.replaceAll(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/gu,
      (_match, alt, url, title) => {
        const titleAttr = title ? ` title="${title}"` : "";
        return `<img src="${url}" alt="${alt}"${titleAttr} />`;
      },
    );
    resultLines.push(replaced);
  }

  return resultLines.join("\n");
}

/** Checks whether a response body is an HTML SPA shell or an error page rather than a markdown document. */
export function isHtmlSpaShellOrErrorPage(
  text: string,
  contentType: string | null,
): boolean {
  const isHtmlType = contentType?.toLowerCase().includes("text/html") ?? false;
  const hasHtmlTag = /<(!doctype\s+html|html|head)[\s>]/iu.test(text);

  if (isHtmlType || hasHtmlTag) {
    const hasSpaRoot =
      /<div\s+id=["'](root|app|__next)["']\s*>\s*<\/div>/iu.test(text);
    if (hasSpaRoot) {
      return true;
    }
    if (
      /<title[^>]*>.*?(404|not\s+found|error|forbidden|access\s+denied|页面不存在|错误).*?<\/title>/iu.test(
        text,
      )
    ) {
      return true;
    }
    const hasMarkdownStructure =
      /^#{1,6}\s+\S+/mu.test(text) || /^[-*+]\s+\S+/mu.test(text);
    if (!hasMarkdownStructure) {
      return true;
    }
  }
  return false;
}

export async function fetchChangelog(
  source: KimiSourceDefinition,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ readonly rawText: string; readonly contentType: string | null }> {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  let response: Response;
  try {
    response = await fetch(source.url, {
      method: "GET",
      headers: {
        accept: "text/markdown, text/plain, */*",
        "user-agent": "Binny SourceAdapter/1.0 (Kimi)",
      },
      signal: requestSignal,
    });
  } catch (error) {
    throw new Error(
      `网络请求失败（${source.url}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(`信源「${source.id}」返回 HTTP ${response.status}。`);
  }
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  return { rawText: text, contentType };
}

export function cleanAndValidateChangelog(
  source: KimiSourceDefinition,
  rawText: string,
  contentType: string | null,
): {
  readonly cleanResult: CleanContentResult;
  readonly dates: ExtractedChangelogDates;
  readonly metadata: JsonObject;
} {
  if (isHtmlSpaShellOrErrorPage(rawText, contentType)) {
    throw new Error(
      `信源「${source.id}」返回了 HTML SPA 外壳或错误页，而非 Markdown 更新日志。`,
    );
  }
  const preprocessed = preprocessMarkdown(rawText);
  const cleanResult = cleanContent(preprocessed, {
    format: "markdown",
    baseUrl: source.url,
  });
  if (
    !cleanResult.hasSubstantialContent ||
    cleanResult.text.trim().length === 0
  ) {
    throw new Error(`信源「${source.id}」正文内容为空或未包含实质性正文。`);
  }

  const dates = extractChangelogDates(rawText);
  const metadata: JsonObject = {
    documentKind: "changelog",
    region: source.region,
    language: source.language,
    ...(dates.latestDate !== undefined ? { latestDate: dates.latestDate } : {}),
    ...(dates.datePrecision !== undefined
      ? { datePrecision: dates.datePrecision }
      : {}),
    ...(dates.observedDates.length > 0
      ? { observedDates: [...dates.observedDates] }
      : {}),
  };

  return { cleanResult, dates, metadata };
}

/** Checks a single Kimi changelog source and records any problems. */
export async function checkChangelogSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  problems: z.infer<typeof checkOutputSchema>["problems"],
): Promise<void> {
  try {
    const { rawText, contentType } = await fetchChangelog(
      source,
      context.signal,
    );
    cleanAndValidateChangelog(source, rawText, contentType);
  } catch (error) {
    problems.push({
      code: "kimi_changelog_unavailable",
      message:
        error instanceof Error
          ? error.message
          : `信源「${source.id}」可用性检查失败。`,
      impact: `Kimi 更新日志「${source.id}」当前不可达或内容无效。`,
      path: ["sources", source.id],
      suggestion: "检查信源 URL 是否可访问以及源端格式是否正常。",
      requiresHuman: false,
    });
  }
}

/** Executes check action on Kimi changelog sources. */
export async function executeChangelogCheck(
  context: SourceAdapterContext<KimiConfig>,
  params: ActionParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const problems: z.infer<typeof checkOutputSchema>["problems"] = [];
  const scope: string[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `未找到配置的信源「${missingId}」。`,
      impact: `信源「${missingId}」无法进行检查。`,
      path: ["sources", missingId],
      suggestion: "检查运行参数中的 sourceIds 是否在配置中存在。",
      requiresHuman: false,
    });
  }

  for (const source of sources) {
    scope.push(source.id);
    if (source.kind !== "changelog") {
      continue;
    }
    await checkChangelogSource(source, context, problems);
  }

  const availability =
    problems.length === 0
      ? "available"
      : scope.length > 0 && problems.length < scope.length
        ? "unavailable"
        : "unavailable";

  return {
    availability,
    scope,
    basis:
      problems.length === 0
        ? `已成功验证 ${scope.length} 个 Kimi 平台更新日志信源可达性及正文内容。`
        : `Kimi 平台更新日志可用性检查完成，发现 ${problems.length} 个问题。`,
    problems,
  };
}
export const executeKimiCheck = executeChangelogCheck;

/** Collects a single Kimi changelog source immediately. */
export async function collectChangelogSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  state: IncrementalSyncState | undefined,
  completedScopes: string[],
  problems: ManualRunFailure[],
): Promise<void> {
  try {
    const { rawText, contentType } = await fetchChangelog(
      source,
      context.signal,
    );
    const { cleanResult, metadata } = cleanAndValidateChangelog(
      source,
      rawText,
      contentType,
    );

    await submitCleanedArticle(context, {
      sourceKey: buildChangelogSourceKey(source),
      sourceRef: source.url,
      title: source.title ?? "Kimi Changelog",
      sourceModifiedAt: undefined,
      metadata,
      properties:
        source.title !== undefined ? { title: source.title } : undefined,
      cleanResult,
      captureScope: {
        sourceId: source.id,
        region: source.region,
        kind: source.kind,
        url: source.url,
      },
    });

    const contentHash = computeOngoingDocumentHash(
      cleanResult.markdown,
      cleanResult.text,
    );

    if (state !== undefined) {
      upsertIncrementalScopeOngoingDocument(state, source.id, source.id, {
        contentHash,
        updatedAt: context.referenceTime,
      });
    }

    completedScopes.push(source.id);
  } catch (error) {
    problems.push({
      code: "kimi_collection_incomplete",
      message: `信源「${source.id}」采集失败：${error instanceof Error ? error.message : String(error)}`,
      impact: `信源「${source.id}」本次未能完成归档。`,
      path: ["sources", source.id],
      suggestion: "检查信源网络可达性与正文格式后重新采集。",
      requiresHuman: false,
    });
  }
}

/** Executes collect action: immediately archives whole-page changelog and updates ongoing document hash. */
export async function executeChangelogCollect(
  context: SourceAdapterContext<KimiConfig>,
  params: ActionParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `未找到配置的信源「${missingId}」。`,
      impact: `信源「${missingId}」无法进行采集。`,
      path: ["sources", missingId],
      suggestion: "检查运行参数中的 sourceIds 是否在配置中存在。",
      requiresHuman: false,
    });
  }

  let state: IncrementalSyncState | undefined;
  if (context.persistentState !== undefined) {
    try {
      state = await loadIncrementalSyncState(context);
    } catch {
      // Ignore state load errors during explicit collect if persistentState is uninitialized or optional
    }
  }

  for (const source of sources) {
    if (source.kind !== "changelog") {
      continue;
    }
    await collectChangelogSource(
      source,
      context,
      state,
      completedScopes,
      problems,
    );
  }

  if (state !== undefined && context.persistentState !== undefined) {
    await saveIncrementalSyncState(context, state);
  }

  if (problems.length > 0) {
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      throw sourceAdapterActionError(firstProblem, completedScopes);
    }
  }

  return { completedScopes };
}
export const executeKimiCollect = executeChangelogCollect;

/** Synchronizes a single Kimi changelog source. */
export async function syncChangelogSource(
  source: KimiSourceDefinition,
  context: SourceAdapterContext<KimiConfig>,
  state: IncrementalSyncState,
  initializedScopes: string[],
  completedScopes: string[],
  problems: ManualRunFailure[],
): Promise<void> {
  try {
    const isInitialized = isIncrementalScopeInitialized(
      state,
      source.id,
      source.url,
    );

    const { rawText, contentType } = await fetchChangelog(
      source,
      context.signal,
    );
    const { cleanResult, metadata } = cleanAndValidateChangelog(
      source,
      rawText,
      contentType,
    );

    const contentHash = computeOngoingDocumentHash(
      cleanResult.markdown,
      cleanResult.text,
    );

    if (!isInitialized) {
      // First sync establishes baseline state WITHOUT submitting to context.archive.submit
      initializeIncrementalScope(state, source.id, {
        scopeUrl: source.url,
        initializedAt: context.referenceTime,
        ongoingDocuments: {
          [source.id]: {
            contentHash,
            updatedAt: context.referenceTime,
          },
        },
      });
      initializedScopes.push(source.id);
      completedScopes.push(source.id);
    } else {
      const previousDoc = getIncrementalScopeOngoingDocument(
        state,
        source.id,
        source.id,
      );
      const changed = hasOngoingDocumentChanged(previousDoc, contentHash);

      if (changed) {
        await submitCleanedArticle(context, {
          sourceKey: buildChangelogSourceKey(source),
          sourceRef: source.url,
          title: source.title ?? "Kimi Changelog",
          sourceModifiedAt: undefined,
          metadata,
          properties:
            source.title !== undefined ? { title: source.title } : undefined,
          cleanResult,
          captureScope: {
            sourceId: source.id,
            region: source.region,
            kind: source.kind,
            url: source.url,
          },
        });
        upsertIncrementalScopeOngoingDocument(state, source.id, source.id, {
          contentHash,
          updatedAt: context.referenceTime,
        });
      }
      updateIncrementalScopeValidators(state, source.id, {
        scopeUrl: source.url,
      });
      completedScopes.push(source.id);
    }
  } catch (error) {
    problems.push({
      code: "kimi_sync_incomplete",
      message: `信源「${source.id}」同步失败：${error instanceof Error ? error.message : String(error)}`,
      impact: `信源「${source.id}」本次未能完成增量同步，该范围未推进状态。`,
      path: ["sources", source.id],
      suggestion: "检查信源网络可达性与正文格式后重新同步。",
      requiresHuman: false,
    });
  }
}

/** Executes sync action on Kimi changelog sources. */
export async function executeChangelogSync(
  context: SourceAdapterContext<KimiConfig>,
  params: ActionParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `未找到配置的信源「${missingId}」。`,
      impact: `信源「${missingId}」无法进行同步。`,
      path: ["sources", missingId],
      suggestion: "检查运行参数中的 sourceIds 是否在配置中存在。",
      requiresHuman: false,
    });
  }

  const state = await loadIncrementalSyncState(context);

  for (const source of sources) {
    if (source.kind !== "changelog") {
      continue;
    }
    await syncChangelogSource(
      source,
      context,
      state,
      initializedScopes,
      completedScopes,
      problems,
    );
  }

  // Save state for any successfully processed scopes
  await saveIncrementalSyncState(context, state);

  if (problems.length > 0) {
    const firstProblem = problems[0];
    if (firstProblem !== undefined) {
      throw sourceAdapterActionError(firstProblem, completedScopes);
    }
  }

  return {
    completedScopes,
    ...(initializedScopes.length > 0 ? { initializedScopes } : {}),
  };
}
export const executeKimiSync = executeChangelogSync;
