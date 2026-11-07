// Source adapter definition for kimi.
import {
  defineSourceAdapter,
  defineSourceAdapterAction,
  incrementalSyncStateSchema,
  loadIncrementalSyncState,
  saveIncrementalSyncState,
  sourceAdapterActionError,
  type ManualRunFailure,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import type { z } from "zod";

import {
  actionParamsSchema,
  checkChangelogSource,
  checkOutputSchema,
  collectChangelogSource,
  collectOutputSchema,
  configSchema,
  selectedSources,
  syncChangelogSource,
  syncOutputSchema,
  type ActionParams,
  type KimiConfig,
} from "./changelog.ts";
import {
  checkResearchSource,
  collectResearchSource,
  syncResearchSource,
} from "./research.ts";

/** Executes check action on both changelog and research sources. */
export async function executeKimiCheck(
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
    if (source.kind === "changelog") {
      await checkChangelogSource(source, context, problems);
    } else if (source.kind === "research") {
      await checkResearchSource(source, context, problems);
    }
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
        ? `已成功验证 ${scope.length} 个 Kimi 信源可达性及正文内容。`
        : `Kimi 信源可用性检查完成，发现 ${problems.length} 个问题。`,
    problems,
  };
}

/** Executes collect action on both changelog and research sources. */
export async function executeKimiCollect(
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

  let state: Awaited<ReturnType<typeof loadIncrementalSyncState>> | undefined;
  if (context.persistentState !== undefined) {
    try {
      state = await loadIncrementalSyncState(context);
    } catch {
      // Ignore state load errors during explicit collect if persistentState is uninitialized or optional
    }
  }

  for (const source of sources) {
    if (source.kind === "changelog") {
      await collectChangelogSource(
        source,
        context,
        state,
        completedScopes,
        problems,
      );
    } else if (source.kind === "research") {
      await collectResearchSource(
        source,
        context,
        state,
        params,
        completedScopes,
        problems,
      );
    }
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

/** Executes sync action on both changelog and research sources. */
export async function executeKimiSync(
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
    if (source.kind === "changelog") {
      await syncChangelogSource(
        source,
        context,
        state,
        initializedScopes,
        completedScopes,
        problems,
      );
    } else if (source.kind === "research") {
      await syncResearchSource(
        source,
        context,
        state,
        initializedScopes,
        completedScopes,
        problems,
      );
    }
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

export const sourceAdapter = defineSourceAdapter({
  id: "kimi",
  version: "0.1.0",
  description: "Kimi regional research and platform changelogs source adapter.",
  environment: {
    browser: { required: false, profileReuseAfterRestart: false },
  },
  configSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, {
      description: "检查 Kimi 信源可用性与正文格式。",
      params: actionParamsSchema,
      output: checkOutputSchema,
      execute: executeKimiCheck,
    }),
    collect: defineSourceAdapterAction(configSchema, {
      description: "即时采集并归档整页 Kimi 更新日志或研究文章与关联媒体。",
      params: actionParamsSchema,
      output: collectOutputSchema,
      execute: executeKimiCollect,
    }),
    sync: defineSourceAdapterAction(configSchema, {
      description:
        "增量同步 Kimi 更新日志与研究文章；首次建立观察基线，后续变更保存版本。",
      params: actionParamsSchema,
      output: syncOutputSchema,
      execute: executeKimiSync,
    }),
  },
});
