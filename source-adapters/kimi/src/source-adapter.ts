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
  extensionsSchema,
  selectedSources,
  syncChangelogSource,
  syncOutputSchema,
  type ActionParams,
  type KimiConfig,
  type KimiExtensions,
} from "./changelog.ts";
import {
  checkResearchSource,
  collectResearchSource,
  syncResearchSource,
} from "./research.ts";

/** Executes check action on both changelog and research sources. */
export async function executeKimiCheck(
  context: SourceAdapterContext<KimiConfig, never, KimiExtensions>,
  params: ActionParams,
): Promise<z.infer<typeof checkOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const problems: z.infer<typeof checkOutputSchema>["problems"] = [];
  const scope: string[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be checked.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
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

  const availability = problems.length === 0 ? "available" : "unavailable";

  return {
    availability,
    scope,
    basis:
      problems.length === 0
        ? `Successfully verified reachability and content for ${scope.length} Kimi source(s).`
        : `Kimi source availability check completed with ${problems.length} problem(s).`,
    problems,
  };
}

/** Executes collect action on both changelog and research sources. */
export async function executeKimiCollect(
  context: SourceAdapterContext<KimiConfig, never, KimiExtensions>,
  params: ActionParams,
): Promise<z.infer<typeof collectOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be collected.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
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
  context: SourceAdapterContext<KimiConfig, never, KimiExtensions>,
  params: ActionParams,
): Promise<z.infer<typeof syncOutputSchema>> {
  const { sources, missing } = selectedSources(context.config, params);
  const completedScopes: string[] = [];
  const initializedScopes: string[] = [];
  const problems: ManualRunFailure[] = [];

  for (const missingId of missing) {
    problems.push({
      code: "kimi_source_not_found",
      message: `Configured source "${missingId}" was not found.`,
      impact: `Source "${missingId}" cannot be synchronized.`,
      path: ["sources", missingId],
      suggestion:
        "Check whether sourceIds in params match configured source IDs.",
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
  extensionsSchema,
  stateSchema: incrementalSyncStateSchema,
  actions: {
    check: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description: "Check Kimi source availability and content format.",
      params: actionParamsSchema,
      output: checkOutputSchema,
      execute: executeKimiCheck,
    }),
    collect: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Collect and archive Kimi changelogs or research articles and associated media immediately.",
      params: actionParamsSchema,
      output: collectOutputSchema,
      execute: executeKimiCollect,
    }),
    sync: defineSourceAdapterAction(configSchema, extensionsSchema, {
      description:
        "Incrementally synchronize Kimi changelogs and research articles; establish baseline on first run and save revisions on subsequent changes.",
      params: actionParamsSchema,
      output: syncOutputSchema,
      execute: executeKimiSync,
    }),
  },
});
