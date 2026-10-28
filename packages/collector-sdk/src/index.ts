// 采集器声明、运行上下文和公共错误帮助。
import { z } from "zod";

export type JsonSchema = z.core.JSONSchema.BaseSchema;

export interface CollectorContext {
  readonly binId: string;
  readonly config: unknown;
  readonly signal: AbortSignal;
}

export interface CollectorEnvironment {
  readonly browser: {
    readonly required: boolean;
    readonly profileReuseAfterRestart: boolean;
    readonly profileReuseUnavailableReason?: string;
  };
}

export interface CollectorAction<TParams extends z.ZodType = z.ZodType> {
  readonly description: string;
  readonly params: TParams;
  execute(
    context: CollectorContext,
    params: z.output<TParams>,
  ): Promise<unknown>;
}

export interface CollectorDefinition<
  TConfig extends z.ZodType = z.ZodType,
  TActions extends Readonly<Record<string, CollectorAction>> = Readonly<
    Record<string, CollectorAction>
  >,
> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: CollectorEnvironment;
  readonly configSchema: TConfig;
  readonly actions: TActions;
}

export interface CollectorManifest {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly environment: CollectorEnvironment;
  readonly configSchema: JsonSchema;
  readonly actions: Readonly<
    Record<
      string,
      {
        readonly description: string;
        readonly params: JsonSchema;
      }
    >
  >;
}

export function defineCollector<
  TConfig extends z.ZodType,
  TActions extends Readonly<Record<string, CollectorAction>>,
>(
  definition: CollectorDefinition<TConfig, TActions>,
): CollectorDefinition<TConfig, TActions> {
  return definition;
}

export function collectorManifest(
  definition: CollectorDefinition,
): CollectorManifest {
  const actions = Object.fromEntries(
    Object.entries(definition.actions).map(([name, action]) => [
      name,
      {
        description: action.description,
        params: z.toJSONSchema(action.params, { io: "input" }),
      },
    ]),
  );

  return {
    id: definition.id,
    version: definition.version,
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    environment: definition.environment,
    configSchema: z.toJSONSchema(definition.configSchema, { io: "input" }),
    actions,
  };
}
