import {
  archivedMedia,
  archiveResourceManifest,
  sourceAdapterActionError,
  defineSourceAdapter,
  defineSourceAdapterAction,
  defineSourceAdapterCheckAction,
  isSourceAdapterActionError,
  type ArchiveResourceMetadata,
  type SourceAdapterCheckContext,
  type SourceAdapterContext,
} from "@binny/source-adapter-sdk";
import { chromium, type APIRequestContext, type Page } from "playwright-core";
import { z } from "zod";

const topicIdSchema = z.number().int().safe().positive();
const targetIdSchema = z
  .string()
  .min(1, "目标标识不能为空。")
  .max(128, "目标标识不能超过 128 个字符。")
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, "目标标识格式无效。");
const siteOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}, "站点地址必须是没有路径、查询或凭据的 HTTP(S) origin。");

const sourceAdapterConfigSchema = z
  .object({ origin: siteOriginSchema })
  .strict();
const selectedTargetsSchema = z
  .array(targetIdSchema)
  .min(1)
  .max(100)
  .superRefine((values, context) => {
    const duplicateIndex = values.findIndex(
      (value, index) => values.indexOf(value) !== index,
    );
    if (duplicateIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: [duplicateIndex],
        message: "本次选择的目标 id 不能重复。",
      });
    }
  });
const checkParamsSchema = z
  .object({
    topicId: topicIdSchema.optional(),
    targetIds: selectedTargetsSchema.optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.topicId !== undefined && params.targetIds !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetIds"],
        message: "topicId 与 targetIds 不能同时使用。",
      });
    }
  });
const collectParamsSchema = z
  .object({
    topicId: topicIdSchema.optional(),
    targetIds: selectedTargetsSchema.optional(),
    createdAfter: z.iso.datetime().optional(),
    maxTopics: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if (params.topicId !== undefined && params.targetIds !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetIds"],
        message: "topicId 与 targetIds 不能同时使用。",
      });
    }
  });
const categorySlugPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^/?#]+(?:\/[^/?#]+)*$/u);
const configuredTargetSchema = z.discriminatedUnion("kind", [
  z.object({ id: targetIdSchema, kind: z.literal("latest") }).strict(),
  z
    .object({
      id: targetIdSchema,
      kind: z.literal("category"),
      categoryId: topicIdSchema,
      categorySlugPath: categorySlugPathSchema,
    })
    .strict(),
  z
    .object({
      id: targetIdSchema,
      kind: z.literal("topic"),
      topicId: topicIdSchema,
    })
    .strict(),
]);
const configuredTargetsSchema = z.array(configuredTargetSchema).max(100);
const discoveredTopicSchema = z
  .object({ id: topicIdSchema, created_at: z.string().optional() })
  .passthrough();
const topicListResponseSchema = z
  .object({
    topic_list: z
      .object({
        topics: z.array(discoveredTopicSchema),
        more_topics_url: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const postIdSchema = z.number().int().safe().positive();
const discourseReplyPostNumberSchema = z
  .union([
    postIdSchema,
    z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number)
      .pipe(postIdSchema),
  ])
  .nullable()
  .optional();

const discourseSessionSchema = z
  .object({
    current_user: z
      .object({ id: postIdSchema, username: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

const discoursePostSchema = z
  .object({
    id: postIdSchema,
    topic_id: topicIdSchema.optional(),
    post_number: postIdSchema,
    cooked: z.string().nullable().optional(),
    username: z.string().optional(),
    name: z.string().nullable().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    reply_to_post_number: discourseReplyPostNumberSchema,
    reply_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const discourseTopicTagSchema = z.union([
  z.string(),
  z
    .object({
      id: postIdSchema,
      name: z.string(),
      slug: z.string(),
    })
    .passthrough(),
]);

const discourseTopicSchema = z
  .object({
    id: topicIdSchema,
    title: z.string().optional(),
    slug: z.string().optional(),
    created_at: z.string().optional(),
    category_id: topicIdSchema.nullable().optional(),
    tags: z.array(discourseTopicTagSchema).optional(),
    post_stream: z
      .object({
        posts: z.array(discoursePostSchema),
        stream: z.array(postIdSchema).optional(),
        isMegaTopic: z.boolean().optional(),
        lastId: postIdSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const topicPostsResponseSchema = z
  .object({
    post_stream: z.object({ posts: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

type DiscoursePost = z.infer<typeof discoursePostSchema>;
type DiscourseTopic = z.infer<typeof discourseTopicSchema>;
type ConfiguredTarget = z.infer<typeof configuredTargetSchema>;
type CollectParams = z.output<typeof collectParamsSchema>;
type CheckParams = z.output<typeof checkParamsSchema>;
type DiscourseProblem = {
  readonly code: string;
  readonly message: string;
  readonly impact: string;
  readonly suggestion: string;
  readonly requiresHuman: boolean;
};
type JsonResponse =
  | { readonly kind: "json"; readonly status: number; readonly value: unknown }
  | { readonly kind: "nonJson"; readonly status: number }
  | { readonly kind: "invalidJson"; readonly status: number }
  | {
      readonly kind: "networkError";
      readonly status: 0;
      readonly message: string;
    };
type TopicAccess =
  | {
      readonly kind: "available";
      readonly siteOrigin: URL;
      readonly siteNamespace: string;
      readonly topic: DiscourseTopic;
      readonly scopeIncomplete: boolean;
    }
  | {
      readonly kind: "unavailable";
      readonly availability: "unavailable" | "unknown";
      readonly problem: DiscourseProblem;
    };
type SessionAccess =
  | { readonly kind: "available" }
  | {
      readonly kind: "unavailable";
      readonly availability: "unavailable" | "unknown";
      readonly problem: DiscourseProblem;
    };
type SharedBrowser = {
  readonly page: Page;
  readonly request: APIRequestContext;
};
type PageFetchResponse = {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
};
type TopicPostRead = {
  readonly posts: readonly DiscoursePost[];
  readonly missingPostIds: readonly number[];
  readonly scopeIncomplete: boolean;
  readonly challenge?: DiscourseProblem;
};
type MediaCandidate = {
  readonly index: number;
  readonly kind: "image" | "attachment";
  readonly url: string;
  readonly path: string;
};
type PreparedBody = {
  readonly html: string;
  readonly text: string;
  readonly media: readonly MediaCandidate[];
};
type MediaDownload =
  | { readonly ok: true; readonly resource: ArchiveResourceMetadata }
  | { readonly ok: false; readonly reason: string };

const checkBasis =
  "通过正式持久浏览器的共享身份读取 Discourse 当前会话和指定主题 JSON；检查不下载媒体、不写入归档。";
const postBatchSize = 100;

function siteFromConfig(value: unknown): {
  readonly origin: URL;
  readonly namespace: string;
} {
  const { origin } = sourceAdapterConfigSchema.parse(value);
  const url = new URL(origin);
  return {
    origin: new URL(url.origin),
    namespace: `linuxdo:${url.host}`,
  };
}

async function withSharedBrowser<T>(
  context: Pick<SourceAdapterContext, "browser" | "signal">,
  callback: (browser: SharedBrowser) => Promise<T>,
): Promise<T> {
  const connection = context.browser;
  if (connection === undefined || connection.protocol !== "playwright") {
    throw new Error("Linux.do 采集需要正式浏览器运行器提供 Playwright 连接。");
  }
  if (connection.playwrightVersion !== "1.64.1") {
    throw new Error(
      "Linux.do 信源适配器与浏览器运行器的 Playwright 版本不一致。",
    );
  }

  const connectedBrowser = await chromium.connect(connection.endpoint);
  try {
    const persistentContext = connectedBrowser.contexts()[0];
    if (persistentContext === undefined) {
      throw new Error("正式浏览器没有暴露持久 context。");
    }
    const page = await persistentContext.newPage();
    try {
      context.signal.throwIfAborted();
      return await callback({ page, request: persistentContext.request });
    } finally {
      await page.close({ runBeforeUnload: false });
    }
  } finally {
    await connectedBrowser.close();
  }
}

async function readJson(
  page: Page,
  url: URL,
  signal: AbortSignal,
): Promise<JsonResponse> {
  signal.throwIfAborted();
  let response: PageFetchResponse;
  try {
    await ensurePageOrigin(page, url, signal);
    response = await fetchInPage(page, url, "application/json", "text");
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return {
      kind: "networkError",
      status: 0,
      message: error instanceof Error ? error.message : "请求没有完成。",
    };
  }

  const contentType = response.contentType;
  if (
    !/(?:^|\s|;)application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(
      contentType,
    )
  ) {
    return { kind: "nonJson", status: response.status };
  }
  try {
    return {
      kind: "json",
      status: response.status,
      value: JSON.parse(response.body) as unknown,
    };
  } catch {
    return { kind: "invalidJson", status: response.status };
  }
}

async function ensurePageOrigin(
  page: Page,
  url: URL,
  signal: AbortSignal,
): Promise<void> {
  let currentOrigin = "";
  try {
    currentOrigin = new URL(page.url()).origin;
  } catch {
    // about:blank 没有可用于同源请求的站点 origin。
  }
  if (currentOrigin === url.origin) return;
  signal.throwIfAborted();
  await page.goto(new URL("/", url).href, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (new URL(page.url()).origin !== url.origin) {
    throw new Error("站点首页跳转到了不同的 origin，无法安全复用浏览器会话。");
  }
}

async function fetchInPage(
  page: Page,
  url: URL,
  accept: string,
  body: "text" | "base64",
): Promise<PageFetchResponse> {
  return await page.evaluate(
    async ({ href, acceptHeader, bodyType }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(href, {
          cache: "no-store",
          credentials: "include",
          headers: { accept: acceptHeader },
          signal: controller.signal,
        });
        let responseBody: string;
        if (bodyType === "text") {
          responseBody = await response.text();
        } else {
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          const chunkSize = 0x8000;
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            binary += String.fromCharCode(
              ...bytes.subarray(offset, offset + chunkSize),
            );
          }
          responseBody = btoa(binary);
        }
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: responseBody,
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    { href: url.href, acceptHeader: accept, bodyType: body },
  );
}

function topicScope(topicId: number): string {
  return `topic:${String(topicId)}`;
}

function checkResult(
  scope: string,
  availability: "available" | "unavailable" | "unknown",
  problems: readonly DiscourseProblem[],
  basis = checkBasis,
) {
  return {
    availability,
    scope: [scope],
    basis,
    problems: [...problems],
  };
}

function accessProblem(
  topicId: number,
  availability: "unavailable" | "unknown",
  problem: DiscourseProblem,
): TopicAccess {
  return { kind: "unavailable", availability, problem };
}

function networkProblem(topicId: number, message: string): TopicAccess {
  return accessProblem(topicId, "unknown", {
    code: "linuxdo_source_unreachable",
    message: `无法读取 Linux.do 主题：${message}`,
    impact: "本次检查无法确认所选主题是否可用，未读取或归档主题内容。",
    suggestion: "检查站点地址、网络连接后重新运行 check。",
    requiresHuman: false,
  });
}

async function readTopicAccess(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  signal: AbortSignal,
): Promise<TopicAccess> {
  const session = await readSessionAccess(page, site, signal);
  if (session.kind === "unavailable") {
    return accessProblem(topicId, session.availability, session.problem);
  }
  return await readTopic(page, site, topicId, signal);
}

async function readSessionAccess(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  signal: AbortSignal,
): Promise<SessionAccess> {
  const sessionUrl = new URL("/session/current.json", site.origin);
  const session = await readJson(page, sessionUrl, signal);
  if (session.kind === "networkError") {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "linuxdo_source_unreachable",
        message: `无法读取 Linux.do 当前会话：${session.message}`,
        impact: "本次检查无法确认所选目标是否可用，未读取或归档主题内容。",
        suggestion: "检查站点地址、网络连接后重新运行 check。",
        requiresHuman: false,
      },
    };
  }
  if (session.status === 404) {
    return {
      kind: "unavailable",
      availability: "unavailable",
      problem: {
        code: "login_required",
        message: "Linux.do 浏览器会话已经退出登录。",
        impact: "本次检查或采集不能读取所选目标。",
        suggestion:
          "使用 human open 在持久浏览器中登录后重新触发 check 或 collect。",
        requiresHuman: true,
      },
    };
  }
  if (session.kind !== "json") {
    const challenge = session.status === 200 || session.status === 403;
    return {
      kind: "unavailable",
      availability: challenge ? "unknown" : "unavailable",
      problem: {
        code: challenge
          ? "discourse_challenge_response"
          : "linuxdo_session_unavailable",
        message: "Linux.do 当前会话端点没有返回可识别的 JSON。",
        impact: "本次检查或采集没有确认登录状态。",
        suggestion:
          "使用 human open 检查登录状态或完成站点要求的人工挑战，再重新触发动作。",
        requiresHuman: challenge,
      },
    };
  }
  if (session.status !== 200) {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "linuxdo_session_check_failed",
        message: `Linux.do 当前会话端点返回 HTTP ${String(session.status)}。`,
        impact: "本次检查或采集没有确认登录状态。",
        suggestion: "检查站点响应后重新运行 check。",
        requiresHuman: false,
      },
    };
  }
  const currentUser = discourseSessionSchema.safeParse(session.value);
  if (!currentUser.success) {
    return {
      kind: "unavailable",
      availability: "unknown",
      problem: {
        code: "discourse_session_response_invalid",
        message: "Linux.do 当前会话端点返回了无法识别的用户资料。",
        impact: "本次检查或采集没有确认登录状态。",
        suggestion:
          "使用 human open 查看站点响应，并在登录状态有效后重新触发动作。",
        requiresHuman: true,
      },
    };
  }

  return { kind: "available" };
}

async function readTopic(
  page: Page,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  signal: AbortSignal,
): Promise<TopicAccess> {
  const topicUrl = new URL(`/t/${String(topicId)}.json`, site.origin);
  const topicResponse = await readJson(page, topicUrl, signal);
  if (topicResponse.kind === "networkError") {
    return networkProblem(topicId, topicResponse.message);
  }
  // JSON 403 表示主题权限；HTML 403 可能是站点挑战，须交给人工处理。
  if (
    topicResponse.status === 404 ||
    (topicResponse.status === 403 && topicResponse.kind === "json")
  ) {
    return accessProblem(topicId, "unavailable", {
      code: "discourse_topic_unavailable",
      message: `已登录账号不能读取主题 ${String(topicId)}。`,
      impact: "本次检查或采集没有读取该主题。",
      suggestion: "确认主题 ID 和账号对该主题的访问权限后重新触发动作。",
      requiresHuman: false,
    });
  }
  if (topicResponse.kind !== "json") {
    const challenge =
      topicResponse.status === 200 || topicResponse.status === 403;
    return accessProblem(topicId, challenge ? "unknown" : "unavailable", {
      code: challenge
        ? "discourse_topic_challenge_response"
        : "discourse_topic_response_invalid",
      message: "Linux.do 主题端点没有返回可识别的 JSON。",
      impact: "本次检查或采集没有确认主题范围。",
      suggestion:
        "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
      requiresHuman: challenge,
    });
  }
  if (topicResponse.status !== 200) {
    return accessProblem(topicId, "unknown", {
      code: "discourse_topic_request_failed",
      message: `Linux.do 主题端点返回 HTTP ${String(topicResponse.status)}。`,
      impact: "本次检查或采集没有确认主题范围。",
      suggestion: "检查站点响应后重新运行 check。",
      requiresHuman: false,
    });
  }

  const checkedTopic = discourseTopicSchema.safeParse(topicResponse.value);
  if (!checkedTopic.success || checkedTopic.data.id !== topicId) {
    return accessProblem(topicId, "unknown", {
      code: "discourse_topic_response_invalid",
      message: "Linux.do 主题响应缺少有效主题身份或帖子流。",
      impact: "本次检查或采集没有确认主题范围。",
      suggestion: "检查主题响应后重新运行 check。",
      requiresHuman: false,
    });
  }

  return {
    kind: "available",
    siteOrigin: site.origin,
    siteNamespace: site.namespace,
    topic: checkedTopic.data,
    scopeIncomplete:
      checkedTopic.data.post_stream.stream === undefined ||
      checkedTopic.data.post_stream.isMegaTopic === true,
  };
}

function failureFromProblem(problem: DiscourseProblem) {
  return sourceAdapterActionError({
    code: problem.code,
    message: problem.message,
    impact: problem.impact,
    suggestion: problem.suggestion,
    requiresHuman: problem.requiresHuman,
  });
}

function failureFromAccess(
  access: Extract<TopicAccess, { kind: "unavailable" }>,
) {
  return failureFromProblem(access.problem);
}

function configuredTargets(value: readonly unknown[]): ConfiguredTarget[] {
  const parsed = configuredTargetsSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw sourceAdapterActionError({
      code: "linuxdo_targets_invalid",
      message: "长期目标配置格式无效。",
      impact: "本次没有读取或归档目标。",
      ...(issue === undefined
        ? { path: ["targets"] }
        : {
            path: [
              "targets",
              ...issue.path.map((part) =>
                typeof part === "symbol" ? String(part) : part,
              ),
            ],
          }),
      suggestion:
        "将 targets 配置为 latest、category 或 topic 目标数组，并为每个目标设置唯一 id。",
      requiresHuman: false,
    });
  }
  const ids = new Set<string>();
  for (const [index, target] of parsed.data.entries()) {
    if (ids.has(target.id)) {
      throw sourceAdapterActionError({
        code: "linuxdo_target_id_duplicate",
        message: `长期目标标识 ${target.id} 重复。`,
        impact: "本次没有读取或归档目标。",
        path: ["targets", index, "id"],
        suggestion: "为每个长期目标设置唯一 id 后重新运行。",
        requiresHuman: false,
      });
    }
    ids.add(target.id);
  }
  return parsed.data;
}

function selectConfiguredTargets(
  rawTargets: readonly unknown[],
  targetIds: readonly string[] | undefined,
): ConfiguredTarget[] {
  const targets = configuredTargets(rawTargets);
  if (targetIds === undefined) {
    if (targets.length === 0) {
      throw sourceAdapterActionError({
        code: "linuxdo_target_required",
        message: "本次运行需要选择或配置至少一个长期目标。",
        impact: "本次没有读取或归档主题资料。",
        path: ["targetIds"],
        suggestion:
          "配置 latest、category 或 topic 目标，或在本次运行选择目标 id。",
        requiresHuman: false,
      });
    }
    return targets;
  }
  const byId = new Map(targets.map((target) => [target.id, target]));
  return targetIds.map((id, index) => {
    const target = byId.get(id);
    if (target === undefined) {
      throw sourceAdapterActionError({
        code: "linuxdo_target_not_found",
        message: `没有配置 id 为 ${id} 的长期目标。`,
        impact: "本次运行没有处理该目标。",
        path: ["targetIds", index],
        suggestion: "检查本次选择的 targetIds 与长期目标配置。",
        requiresHuman: false,
      });
    }
    return target;
  });
}

function targetScope(target: ConfiguredTarget): string {
  return `target:${target.id}`;
}

function targetListUrl(
  site: ReturnType<typeof siteFromConfig>,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
  maxTopics: number,
  createdAfter: string | undefined,
): URL {
  const pathname =
    target.kind === "latest"
      ? "/latest.json"
      : `/c/${target.categorySlugPath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}/${String(target.categoryId)}/l/latest.json`;
  const url = new URL(pathname, site.origin);
  url.searchParams.set("per_page", String(Math.min(maxTopics, 100)));
  if (createdAfter !== undefined) {
    url.searchParams.set("order", "created");
    url.searchParams.set("ascending", "false");
  }
  return url;
}

function paginationUrl(
  value: string,
  currentUrl: URL,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
): URL {
  let nextUrl: URL;
  try {
    nextUrl = new URL(value, currentUrl);
  } catch {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_pagination_invalid",
      message: "Linux.do 列表分页链接格式无效。",
      impact: "本次只处理了分页链接前的主题。",
      suggestion: "检查受控目标的 Discourse 列表响应后重新运行 collect。",
      requiresHuman: false,
    });
  }
  const targetPath =
    target.kind === "latest"
      ? "/latest.json"
      : `/c/${target.categorySlugPath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}/${String(target.categoryId)}/l/latest.json`;
  const extensionlessTargetPath = targetPath.replace(/\.json$/u, "");
  const latestCategoryPath =
    target.kind === "category" &&
    (nextUrl.pathname === "/latest.json" || nextUrl.pathname === "/latest") &&
    nextUrl.searchParams.get("category") === String(target.categoryId);
  const validPath =
    nextUrl.pathname === targetPath ||
    nextUrl.pathname === extensionlessTargetPath ||
    latestCategoryPath;
  const validCategoryFilter =
    nextUrl.searchParams.get("category") === null ||
    (target.kind === "category" &&
      nextUrl.searchParams.get("category") === String(target.categoryId));
  if (
    nextUrl.origin !== currentUrl.origin ||
    !validPath ||
    !validCategoryFilter ||
    nextUrl.username.length > 0 ||
    nextUrl.password.length > 0 ||
    nextUrl.hash.length > 0
  ) {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_pagination_invalid",
      message: "Linux.do 列表分页链接超出了所选目标范围。",
      impact: "本次只处理了分页链接前的主题。",
      suggestion: "检查受控目标的 Discourse 列表响应后重新运行 collect。",
      requiresHuman: false,
    });
  }
  if (nextUrl.pathname === extensionlessTargetPath) {
    nextUrl.pathname = targetPath;
  } else if (latestCategoryPath && nextUrl.pathname === "/latest") {
    nextUrl.pathname = "/latest.json";
  }
  for (const key of ["per_page", "order", "ascending"]) {
    const valueFromCurrent = currentUrl.searchParams.get(key);
    if (valueFromCurrent !== null && !nextUrl.searchParams.has(key)) {
      nextUrl.searchParams.set(key, valueFromCurrent);
    }
  }
  return nextUrl;
}

async function readTopicListPage(
  page: Page,
  url: URL,
  signal: AbortSignal,
): Promise<z.output<typeof topicListResponseSchema>["topic_list"]> {
  const response = await readJson(page, url, signal);
  if (response.kind === "networkError") {
    throw sourceAdapterActionError({
      code: "linuxdo_source_unreachable",
      message: `无法读取 Linux.do 主题列表：${response.message}`,
      impact: "本次没有确认该目标的列表范围。",
      suggestion: "检查站点地址、网络连接后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  if (
    response.status === 404 ||
    (response.status === 403 && response.kind === "json")
  ) {
    throw sourceAdapterActionError({
      code: "discourse_target_unavailable",
      message: "已登录账号不能读取所选 Linux.do 列表目标。",
      impact: "本次没有处理该目标的主题。",
      suggestion: "确认分类路径、目标可见性与账号权限后重新运行。",
      requiresHuman: false,
    });
  }
  if (response.kind !== "json") {
    const challenge = response.status === 200 || response.status === 403;
    throw sourceAdapterActionError({
      code: challenge
        ? "discourse_target_challenge_response"
        : "discourse_target_response_invalid",
      message: "Linux.do 列表端点没有返回可识别的 JSON。",
      impact: "本次没有确认该目标的列表范围。",
      suggestion:
        "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
      requiresHuman: challenge,
    });
  }
  if (response.status !== 200) {
    throw sourceAdapterActionError({
      code: "discourse_target_request_failed",
      message: `Linux.do 列表端点返回 HTTP ${String(response.status)}。`,
      impact: "本次没有确认该目标的列表范围。",
      suggestion: "检查站点响应后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  const parsed = topicListResponseSchema.safeParse(response.value);
  if (!parsed.success) {
    throw sourceAdapterActionError({
      code: "discourse_topic_list_response_invalid",
      message: "Linux.do 列表响应缺少有效主题集合或分页信息。",
      impact: "本次没有确认该目标的完整列表范围。",
      suggestion: "检查站点列表响应后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  return parsed.data.topic_list;
}

function targetCheckResult(
  scopes: readonly string[],
  availability: "available" | "unavailable" | "unknown",
  problems: readonly DiscourseProblem[],
) {
  return {
    availability,
    scope: [...scopes],
    basis:
      "通过正式持久浏览器的共享身份读取 Discourse 当前会话及所选目标的第一列表页或主题 JSON；检查不下载媒体、不写入归档。",
    problems: [...problems],
  };
}

function listCheckDiagnostic(
  error: unknown,
):
  | { availability: "unavailable" | "unknown"; problem: DiscourseProblem }
  | undefined {
  if (!isSourceAdapterActionError(error)) return undefined;
  const { failure } = error;
  // 只转换列表读取和分页校验识别的源站结果；其他执行故障仍按失败上抛。
  const availabilityBySourceCode: Readonly<
    Record<string, "unavailable" | "unknown">
  > = {
    linuxdo_source_unreachable: "unknown",
    discourse_target_unavailable: "unavailable",
    discourse_target_challenge_response: "unknown",
    discourse_target_response_invalid: "unavailable",
    discourse_target_request_failed: "unknown",
    discourse_topic_list_response_invalid: "unknown",
    discourse_topic_list_pagination_invalid: "unknown",
  };
  const availability = availabilityBySourceCode[failure.code];
  if (availability === undefined || failure.suggestion === undefined) {
    return undefined;
  }
  return {
    availability,
    problem: {
      code: failure.code,
      message: failure.message,
      impact: failure.impact,
      suggestion: failure.suggestion,
      requiresHuman: failure.requiresHuman,
    },
  };
}

async function checkTopic(
  context: SourceAdapterCheckContext,
  params: CheckParams,
) {
  const site = siteFromConfig(context.config);
  if (params.topicId !== undefined) {
    return await checkOneTopic(context, site, params.topicId);
  }
  const targets = selectConfiguredTargets(context.targets, params.targetIds);
  const scopes = targets.map(targetScope);
  return await withSharedBrowser(context, async ({ page }) => {
    const session = await readSessionAccess(page, site, context.signal);
    if (session.kind === "unavailable") {
      return targetCheckResult(scopes, session.availability, [session.problem]);
    }
    const problems: DiscourseProblem[] = [];
    let availability: "available" | "unavailable" | "unknown" = "available";
    for (const target of targets) {
      if (target.kind === "topic") {
        const access = await readTopic(
          page,
          site,
          target.topicId,
          context.signal,
        );
        if (access.kind === "unavailable") {
          problems.push(access.problem);
          availability = access.availability;
          continue;
        }
        const posts = await readTopicPosts(
          page,
          access.siteOrigin,
          access.topic,
          context.signal,
        );
        if (posts.challenge !== undefined) {
          problems.push(posts.challenge);
          availability = "unknown";
          continue;
        }
        problems.push(...topicProblems(access, posts));
      } else {
        // 单条主题足以诊断目标可读性，也能检查 Discourse 的下一页链接。
        const listUrl = targetListUrl(site, target, 1, undefined);
        try {
          const response = await readTopicListPage(
            page,
            listUrl,
            context.signal,
          );
          if (
            response.more_topics_url !== null &&
            response.more_topics_url !== undefined
          ) {
            paginationUrl(response.more_topics_url, listUrl, target);
          }
        } catch (error) {
          const diagnostic = listCheckDiagnostic(error);
          if (diagnostic === undefined) throw error;
          problems.push(diagnostic.problem);
          availability = diagnostic.availability;
          continue;
        }
      }
    }
    return targetCheckResult(scopes, availability, problems);
  });
}

async function checkOneTopic(
  context: SourceAdapterCheckContext,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
) {
  return await withSharedBrowser(context, async ({ page }) => {
    const access = await readTopicAccess(page, site, topicId, context.signal);
    if (access.kind === "unavailable") {
      return checkResult(topicScope(topicId), access.availability, [
        access.problem,
      ]);
    }
    const posts = await readTopicPosts(
      page,
      access.siteOrigin,
      access.topic,
      context.signal,
    );
    if (posts.challenge !== undefined) {
      return checkResult(topicScope(topicId), "unknown", [posts.challenge]);
    }
    const problems = topicProblems(access, posts);
    return checkResult(topicScope(topicId), "available", problems);
  });
}

function topicProblems(
  access: Extract<TopicAccess, { kind: "available" }>,
  posts: TopicPostRead,
): DiscourseProblem[] {
  const problems: DiscourseProblem[] = [];
  if (
    access.scopeIncomplete ||
    posts.scopeIncomplete ||
    posts.missingPostIds.length > 0
  ) {
    problems.push({
      code: "discourse_topic_scope_partial",
      message: "主题可读，但本次没有取得主题声明的全部帖子正文。",
      impact: "采集可以保存已返回的帖子，未观察到的帖子和关系不会自动撤回。",
      suggestion: "检查帖子端点响应与账号权限后重新运行 check 或 collect。",
      requiresHuman: false,
    });
  }
  if (
    posts.posts.some(
      (post) =>
        typeof post.cooked !== "string" || post.cooked.trim().length === 0,
    )
  ) {
    problems.push({
      code: "discourse_post_body_missing",
      message: "至少一条帖子没有返回可归档的正文 HTML。",
      impact: "本次采集会为受影响帖子保留缺失说明。",
      suggestion: "检查站点返回与账号权限后重新运行 collect。",
      requiresHuman: false,
    });
  }
  return problems;
}

function sourceKey(namespace: string, postId: number) {
  return { namespace, key: `post:${String(postId)}` };
}

function sourcePostUrl(
  siteOrigin: URL,
  topic: DiscourseTopic,
  post: DiscoursePost,
): string {
  const path =
    topic.slug === undefined || topic.slug.length === 0
      ? `/t/${String(topic.id)}/${String(post.post_number)}`
      : `/t/${encodeURIComponent(topic.slug)}/${String(topic.id)}/${String(post.post_number)}`;
  return new URL(path, siteOrigin).href;
}

function postRelation(
  namespace: string,
  topicId: number,
  rootPostId: number,
  post: DiscoursePost,
) {
  return {
    relationId: `${namespace}:topic:${String(topicId)}:reply:${String(post.id)}`,
    value: {
      from: sourceKey(namespace, rootPostId),
      to: { sourceKey: sourceKey(namespace, post.id) },
      name: "topic_reply",
      properties: {
        topicId,
        postNumber: post.post_number,
        replyToPostNumber: post.reply_to_post_number ?? 1,
      },
      cascade: true,
    },
  };
}

async function readTopicPosts(
  page: Page,
  siteOrigin: URL,
  topic: DiscourseTopic,
  signal: AbortSignal,
): Promise<TopicPostRead> {
  const postsById = new Map<number, DiscoursePost>();
  for (const post of topic.post_stream.posts) {
    if (post.topic_id === undefined || post.topic_id === topic.id) {
      postsById.set(post.id, post);
    }
  }
  const streamIds = topic.post_stream.stream ?? [];
  const requestedPostIds = [...new Set([...streamIds, ...postsById.keys()])];
  const missingPostIds = new Set<number>();

  // topic.json 的 posts 只含首批正文；stream 才列出后续可见帖子 ID。
  for (
    let offset = 0;
    offset < requestedPostIds.length;
    offset += postBatchSize
  ) {
    const batch = requestedPostIds.slice(offset, offset + postBatchSize);
    const unresolved = batch.filter((postId) => !postsById.has(postId));
    if (unresolved.length === 0) continue;

    const postsUrl = new URL(`/t/${String(topic.id)}/posts.json`, siteOrigin);
    for (const postId of unresolved) {
      postsUrl.searchParams.append("post_ids[]", String(postId));
    }
    const response = await readJson(page, postsUrl, signal);
    if (
      response.kind !== "json" &&
      (response.status === 200 || response.status === 403)
    ) {
      return {
        posts: [...postsById.values()].toSorted(
          (first, second) => first.post_number - second.post_number,
        ),
        missingPostIds: [...unresolved].toSorted(
          (first, second) => first - second,
        ),
        scopeIncomplete:
          topic.post_stream.stream === undefined ||
          topic.post_stream.isMegaTopic === true,
        challenge: {
          code: "discourse_topic_posts_challenge_response",
          message: "Linux.do 帖子补取端点没有返回可识别的 JSON。",
          impact: "本次检查或采集不能确认主题的完整回复范围。",
          suggestion:
            "使用 human open 查看站点状态，完成必要的人工挑战后重新触发动作。",
          requiresHuman: true,
        },
      };
    }
    if (response.kind !== "json" || response.status !== 200) {
      for (const postId of unresolved) missingPostIds.add(postId);
      continue;
    }
    const envelope = topicPostsResponseSchema.safeParse(response.value);
    if (!envelope.success) {
      for (const postId of unresolved) missingPostIds.add(postId);
      continue;
    }
    for (const value of envelope.data.post_stream.posts) {
      const post = discoursePostSchema.safeParse(value);
      if (
        !post.success ||
        !unresolved.includes(post.data.id) ||
        (post.data.topic_id !== undefined && post.data.topic_id !== topic.id)
      ) {
        continue;
      }
      postsById.set(post.data.id, post.data);
    }
    for (const postId of unresolved) {
      if (!postsById.has(postId)) missingPostIds.add(postId);
    }
  }

  return {
    posts: [...postsById.values()].toSorted(
      (first, second) => first.post_number - second.post_number,
    ),
    missingPostIds: [...missingPostIds].toSorted(
      (first, second) => first - second,
    ),
    scopeIncomplete:
      topic.post_stream.stream === undefined ||
      topic.post_stream.isMegaTopic === true,
  };
}

async function prepareCookedBody(
  page: Page,
  cooked: string,
): Promise<PreparedBody> {
  return await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");
    const media: MediaCandidate[] = [];
    const imageLightboxes = new Set<Element>();
    let imageNumber = 0;
    let attachmentNumber = 0;

    for (const image of document.body.querySelectorAll("img")) {
      const source = image.getAttribute("src");
      const isEmoji =
        image.classList.contains("emoji") ||
        (source !== null && /\/(?:emoji|_avatar)(?:\/|\.)/iu.test(source));
      if (isEmoji) {
        image.replaceWith(
          document.createTextNode(
            image.getAttribute("alt") || image.getAttribute("title") || "",
          ),
        );
        continue;
      }
      if (source === null || source.length === 0) continue;

      const lightbox = image.closest("a.lightbox[href]");
      const url = lightbox?.getAttribute("href") ?? source;
      const index = media.length;
      const path = `body.images[${String(imageNumber)}]`;
      imageNumber += 1;
      image.setAttribute("data-binny-media-index", String(index));
      if (lightbox !== null) {
        lightbox.setAttribute("data-binny-media-index", String(index));
        imageLightboxes.add(lightbox);
      }
      media.push({ index, kind: "image", url, path });
    }

    for (const attachment of document.body.querySelectorAll(
      "a.attachment[href], a[data-download-href]",
    )) {
      // Discourse 的 lightbox 下载别名指向图片变体，不是另一份附件。
      if (imageLightboxes.has(attachment)) continue;
      const url =
        attachment.getAttribute("data-download-href") ??
        attachment.getAttribute("href");
      if (url === null || url.length === 0) continue;
      const index = media.length;
      attachment.setAttribute("data-binny-media-index", String(index));
      media.push({
        index,
        kind: "attachment",
        url,
        path: `body.attachments[${String(attachmentNumber)}]`,
      });
      attachmentNumber += 1;
    }

    return {
      html: document.body.innerHTML,
      text: (document.body.textContent ?? "").replace(/\s+/gu, " ").trim(),
      media,
    };
  }, cooked);
}

async function rewriteCookedBody(
  page: Page,
  html: string,
  references: ReadonlyMap<number, string>,
): Promise<{ readonly html: string; readonly text: string }> {
  return await page.evaluate(
    ({ source, replacements }) => {
      const document = new DOMParser().parseFromString(source, "text/html");
      for (const element of document.body.querySelectorAll(
        "[data-binny-media-index]",
      )) {
        const key = Number(element.getAttribute("data-binny-media-index"));
        const reference = replacements.find(([index]) => index === key)?.[1];
        if (reference !== undefined) {
          if (element instanceof HTMLImageElement) {
            element.setAttribute("src", reference);
            // 移除源站自适应候选，避免浏览器绕过已归档的 src 再次取图。
            element.removeAttribute("srcset");
            element
              .closest("picture")
              ?.querySelectorAll("source[srcset]")
              .forEach((source) => source.removeAttribute("srcset"));
          } else if (element instanceof HTMLAnchorElement) {
            element.setAttribute("href", reference);
            if (element.hasAttribute("data-download-href")) {
              element.setAttribute("data-download-href", reference);
            }
          }
        }
        element.removeAttribute("data-binny-media-index");
      }
      return {
        html: document.body.innerHTML,
        text: (document.body.textContent ?? "").replace(/\s+/gu, " ").trim(),
      };
    },
    { source: html, replacements: [...references.entries()] },
  );
}

async function downloadMedia(
  page: Page,
  request: APIRequestContext,
  kind: MediaCandidate["kind"],
  url: string,
  siteOrigin: URL,
  context: SourceAdapterContext,
): Promise<MediaDownload> {
  let mediaUrl: URL;
  try {
    mediaUrl = new URL(url, siteOrigin);
  } catch {
    return { ok: false, reason: "媒体地址格式无效。" };
  }
  if (
    (mediaUrl.protocol !== "http:" && mediaUrl.protocol !== "https:") ||
    mediaUrl.username.length > 0 ||
    mediaUrl.password.length > 0
  ) {
    return { ok: false, reason: "媒体地址不是可读取的 HTTP(S) 资源。" };
  }

  context.signal.throwIfAborted();
  let status: number;
  let mediaType: string | undefined;
  let body: Uint8Array;
  try {
    if (mediaUrl.origin === siteOrigin.origin) {
      await ensurePageOrigin(page, mediaUrl, context.signal);
      const response = await fetchInPage(page, mediaUrl, "*/*", "base64");
      status = response.status;
      mediaType = response.contentType;
      body = Buffer.from(response.body, "base64");
    } else {
      const response = await request.get(mediaUrl.href, { timeout: 30_000 });
      status = response.status();
      mediaType = response.headers()["content-type"];
      body = await response.body();
    }
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "媒体请求没有完成。",
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: `媒体端点返回 HTTP ${String(status)}。`,
    };
  }

  mediaType =
    (mediaType ?? "application/octet-stream")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "application/octet-stream";
  if (
    mediaType === "text/html" ||
    mediaType === "application/xhtml+xml" ||
    (kind === "image" &&
      (mediaType.startsWith("text/") ||
        mediaType === "application/json" ||
        mediaType.endsWith("+json")))
  ) {
    return {
      ok: false,
      reason: "媒体端点返回了页面或结构化内容，未取得媒体字节。",
    };
  }
  if (body.byteLength === 0) {
    return { ok: false, reason: "媒体端点返回了空文件。" };
  }

  const upload = await context.resources.upload(
    new Blob([Uint8Array.from(body)], { type: mediaType }),
    mediaType,
  );
  return upload.ok
    ? { ok: true, resource: upload.resource }
    : { ok: false, reason: upload.error.message };
}

function modifiedAt(post: DiscoursePost): string | undefined {
  if (post.updated_at === undefined) return undefined;
  const timestamp = Date.parse(post.updated_at);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function postDiagnostics(
  topicId: number,
  missingPostIds: readonly number[],
  scopeIncomplete: boolean,
) {
  const diagnostics = [];
  if (missingPostIds.length > 0) {
    diagnostics.push({
      code: "discourse_posts_missing",
      message: `主题 ${String(topicId)} 的帖子流声明了 ${String(missingPostIds.length)} 个帖子，但本次没有返回其正文。`,
      details: { topicId, postIds: [...missingPostIds] },
      suggestion:
        "检查主题访问权限与帖子端点响应后重新运行 collect；本次未观察到的旧关系不会自动撤回。",
    });
  }
  if (scopeIncomplete) {
    diagnostics.push({
      code: "discourse_topic_scope_incomplete",
      message: `主题 ${String(topicId)} 没有返回可枚举的完整帖子 ID 列表。`,
      details: { topicId },
      suggestion: "本次只保存已返回的帖子，不会因有限观察撤回已有条目或关系。",
    });
  }
  return diagnostics;
}

async function archivePost(
  page: Page,
  request: APIRequestContext,
  context: SourceAdapterContext,
  siteOrigin: URL,
  siteNamespace: string,
  topic: DiscourseTopic,
  post: DiscoursePost,
  diagnostics: ReturnType<typeof postDiagnostics>,
  mediaCache: Map<string, MediaDownload>,
) {
  const prepared = await prepareCookedBody(page, post.cooked ?? "");
  const references = new Map<number, string>();
  const resources: ArchiveResourceMetadata[] = [];
  const missing: { path: string; reason: string }[] = [];
  const itemDiagnostics: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly suggestion?: string;
  }[] = post.post_number === 1 ? [...diagnostics] : [];

  for (const candidate of prepared.media) {
    let mediaUrl = candidate.url;
    try {
      mediaUrl = new URL(candidate.url, siteOrigin).href;
    } catch {
      // downloadMedia 将无效地址转换为可见的部分采集结果。
    }
    let downloaded = mediaCache.get(mediaUrl);
    if (downloaded === undefined) {
      downloaded = await downloadMedia(
        page,
        request,
        candidate.kind,
        mediaUrl,
        siteOrigin,
        context,
      );
      mediaCache.set(mediaUrl, downloaded);
    }
    if (downloaded.ok) {
      const mediaPart = archivedMedia(downloaded.resource);
      references.set(candidate.index, mediaPart.reference);
      resources.push(downloaded.resource);
    } else {
      // 缺失原因属于版本状态；具体响应差异只记在本次观察诊断中。
      missing.push({
        path: candidate.path,
        reason: "媒体资源未能归档。",
      });
      itemDiagnostics.push({
        code: "linuxdo_media_unavailable",
        message: `帖子 ${String(post.id)} 的媒体未能归档：${downloaded.reason}`,
        details: {
          topicId: topic.id,
          postId: post.id,
          path: candidate.path,
          reason: downloaded.reason,
        },
        suggestion: "检查媒体端点响应后重新运行 collect。",
      });
    }
  }

  if ((post.cooked ?? "").trim().length === 0) {
    missing.push({
      path: "body.html",
      reason: "帖子没有返回可归档的 cooked 正文。",
    });
  }
  const body = await rewriteCookedBody(page, prepared.html, references);
  const searchText = [
    post.post_number === 1 ? topic.title?.trim() : undefined,
    body.text.trim(),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  const sourceModifiedAt = modifiedAt(post);
  const state = {
    sourceKey: sourceKey(siteNamespace, post.id),
    sourceRef: sourcePostUrl(siteOrigin, topic, post),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    metadata: {
      topicId: topic.id,
      postId: post.id,
      postNumber: post.post_number,
      author: {
        username: post.username ?? null,
        name: post.name ?? null,
      },
      ...(post.created_at === undefined ? {} : { createdAt: post.created_at }),
      ...(post.post_number === 1
        ? {
            topic: {
              title: topic.title ?? null,
              slug: topic.slug ?? null,
              categoryId: topic.category_id ?? null,
              tags:
                topic.tags?.map((tag) =>
                  typeof tag === "string" ? tag : tag.name,
                ) ?? [],
              ...(topic.created_at === undefined
                ? {}
                : { createdAt: topic.created_at }),
            },
          }
        : {}),
    },
    body: { html: body.html, text: body.text, searchText },
    resources: [...archiveResourceManifest(resources)],
    capture: {
      scope: {
        origin: siteOrigin.origin,
        topicId: topic.id,
        postId: post.id,
        postNumber: post.post_number,
      },
      completeness:
        missing.length === 0 ? ("complete" as const) : ("partial" as const),
      missing,
    },
    ...(itemDiagnostics.length > 0 ? { diagnostics: itemDiagnostics } : {}),
  };
  return { state, complete: missing.length === 0 };
}

async function collectTopicContent(
  context: SourceAdapterContext,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  topicId: number,
  completedScopes: string[],
  knownAccess?: TopicAccess,
): Promise<void> {
  const access =
    knownAccess ?? (await readTopic(page, site, topicId, context.signal));
  if (access.kind === "unavailable") throw failureFromAccess(access);

  const read = await readTopicPosts(
    page,
    access.siteOrigin,
    access.topic,
    context.signal,
  );
  if (read.challenge !== undefined) {
    throw failureFromProblem(read.challenge);
  }
  const root = read.posts.find(({ post_number }) => post_number === 1);
  if (root === undefined) {
    throw sourceAdapterActionError({
      code: "discourse_topic_root_missing",
      message: `主题 ${String(topicId)} 的主帖没有出现在可读取帖子中。`,
      impact: "本次没有提交主题帖子或关系，已有归档保持不变。",
      suggestion: "检查当前账号对主帖的访问权限后重新运行 collect。",
      requiresHuman: false,
    });
  }

  const diagnostics = postDiagnostics(
    access.topic.id,
    read.missingPostIds,
    read.scopeIncomplete,
  );
  const mediaCache = new Map<string, MediaDownload>();
  let allPostsComplete = true;
  for (let offset = 0; offset < read.posts.length; offset += postBatchSize) {
    context.signal.throwIfAborted();
    const batch = read.posts.slice(offset, offset + postBatchSize);
    const items: Awaited<ReturnType<typeof archivePost>>["state"][] = [];
    for (const post of batch) {
      const archived = await archivePost(
        page,
        request,
        context,
        access.siteOrigin,
        access.siteNamespace,
        access.topic,
        post,
        diagnostics,
        mediaCache,
      );
      items.push(archived.state);
      allPostsComplete &&= archived.complete;
    }
    const relations = batch
      .filter(({ post_number }) => post_number !== 1)
      .map((post) =>
        postRelation(access.siteNamespace, access.topic.id, root.id, post),
      );
    await context.archive.submit({ items, relations });
    completedScopes.push(...batch.map(({ id }) => `post:${String(id)}`));
  }
  if (
    read.missingPostIds.length === 0 &&
    !read.scopeIncomplete &&
    allPostsComplete &&
    read.posts.every((post) => post.cooked !== undefined)
  ) {
    completedScopes.push(topicScope(access.topic.id));
  }
}

function topicMatchesCutoff(
  topicId: number,
  createdAt: string | undefined,
  createdAfter: string | undefined,
): boolean {
  if (createdAfter === undefined) return true;
  const created = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    throw sourceAdapterActionError({
      code: "discourse_topic_created_at_invalid",
      message: `主题 ${String(topicId)} 没有有效的创建时间，无法应用 createdAfter。`,
      impact: "本次无法确认该主题是否位于所选时间范围。",
      suggestion: "检查 Discourse 列表中的 created_at 后重新运行。",
      requiresHuman: false,
    });
  }
  return created >= Date.parse(createdAfter);
}

type DiscoveryProgress = {
  readonly seenTopicIds: Set<number>;
  collectedTopics: number;
};

async function collectListTarget(
  context: SourceAdapterContext,
  page: Page,
  request: APIRequestContext,
  site: ReturnType<typeof siteFromConfig>,
  target: Extract<ConfiguredTarget, { kind: "latest" | "category" }>,
  maxTopics: number,
  createdAfter: string | undefined,
  progress: DiscoveryProgress,
  completedScopes: string[],
): Promise<"complete" | "limited"> {
  const initialUrl = targetListUrl(site, target, maxTopics, createdAfter);
  const visitedPages = new Set<string>();
  let pageUrl: URL | undefined = initialUrl;
  while (pageUrl !== undefined) {
    context.signal.throwIfAborted();
    if (visitedPages.has(pageUrl.href)) {
      throw sourceAdapterActionError({
        code: "discourse_topic_list_pagination_loop",
        message: "Linux.do 列表分页重复返回了已读取页面。",
        impact: "本次只处理了分页循环前的主题。",
        suggestion: "检查受控目标的 Discourse 分页响应后重新运行 collect。",
        requiresHuman: false,
      });
    }
    visitedPages.add(pageUrl.href);
    const topicList = await readTopicListPage(page, pageUrl, context.signal);
    for (const listedTopic of topicList.topics) {
      if (progress.seenTopicIds.has(listedTopic.id)) continue;
      progress.seenTopicIds.add(listedTopic.id);
      if (
        !topicMatchesCutoff(
          listedTopic.id,
          listedTopic.created_at,
          createdAfter,
        )
      ) {
        continue;
      }
      if (progress.collectedTopics >= maxTopics) return "limited";
      await collectTopicContent(
        context,
        page,
        request,
        site,
        listedTopic.id,
        completedScopes,
      );
      progress.collectedTopics += 1;
    }
    if (
      topicList.more_topics_url === null ||
      topicList.more_topics_url === undefined
    ) {
      completedScopes.push(targetScope(target));
      return "complete";
    }
    pageUrl = paginationUrl(topicList.more_topics_url, pageUrl, target);
  }
  completedScopes.push(targetScope(target));
  return "complete";
}

function limitedScope(target: ConfiguredTarget, maxTopics: number): string {
  return `${targetScope(target)}:limited:maxTopics=${String(maxTopics)}`;
}

function unvisitedScope(target: ConfiguredTarget, maxTopics: number): string {
  return `${targetScope(target)}:not-visited:maxTopics=${String(maxTopics)}`;
}

function failureWithProgress(
  error: unknown,
  context: SourceAdapterContext,
  completedScopes: readonly string[],
) {
  if (isSourceAdapterActionError(error)) {
    const errorScopes = Array.isArray(error.completedScopes)
      ? error.completedScopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [];
    return sourceAdapterActionError(error.failure, [
      ...completedScopes,
      ...errorScopes,
    ]);
  }
  if (context.signal.aborted) {
    return sourceAdapterActionError(
      {
        code: "source_adapter_action_cancelled",
        message: "Linux.do 采集已取消。",
        impact: `本次已提交 ${String(completedScopes.length)} 个范围；其余选中主题未完成。`,
        suggestion: "确认取消原因后，可重新运行尚未完成的发现范围。",
        requiresHuman: false,
      },
      completedScopes,
    );
  }
  return sourceAdapterActionError(
    {
      code: "linuxdo_collection_failed",
      message: "Linux.do 采集未能完成。",
      impact: `本次已提交 ${String(completedScopes.length)} 个范围；其余选中主题未完成。`,
      suggestion: "稍后重试；如持续失败，请检查站点状态后重新运行。",
      requiresHuman: false,
    },
    completedScopes,
  );
}

async function collectTopic(
  context: SourceAdapterContext,
  params: CollectParams,
): Promise<{ readonly completedScopes: readonly string[] }> {
  const targets =
    params.topicId === undefined
      ? selectConfiguredTargets(context.targets, params.targetIds)
      : [];
  const site = siteFromConfig(context.config);
  const completedScopes: string[] = [];
  try {
    return await withSharedBrowser(context, async ({ page, request }) => {
      const session = await readSessionAccess(page, site, context.signal);
      if (session.kind === "unavailable") {
        throw failureFromProblem(session.problem);
      }
      if (params.topicId !== undefined) {
        const access = await readTopic(
          page,
          site,
          params.topicId,
          context.signal,
        );
        if (access.kind === "unavailable") throw failureFromAccess(access);
        if (
          !topicMatchesCutoff(
            params.topicId,
            access.topic.created_at,
            params.createdAfter,
          )
        ) {
          completedScopes.push(
            `${topicScope(params.topicId)}:filtered:createdAfter`,
          );
          return { completedScopes };
        }
        await collectTopicContent(
          context,
          page,
          request,
          site,
          params.topicId,
          completedScopes,
          access,
        );
        return { completedScopes };
      }

      const maxTopics = params.maxTopics ?? 30;
      const progress: DiscoveryProgress = {
        seenTopicIds: new Set(),
        collectedTopics: 0,
      };
      for (const [index, target] of targets.entries()) {
        context.signal.throwIfAborted();
        if (progress.collectedTopics >= maxTopics) {
          for (const remainingTarget of targets.slice(index)) {
            completedScopes.push(unvisitedScope(remainingTarget, maxTopics));
          }
          break;
        }
        if (target.kind === "topic") {
          if (progress.seenTopicIds.has(target.topicId)) {
            completedScopes.push(targetScope(target));
            continue;
          }
          progress.seenTopicIds.add(target.topicId);
          const access = await readTopic(
            page,
            site,
            target.topicId,
            context.signal,
          );
          if (access.kind === "unavailable") throw failureFromAccess(access);
          if (
            !topicMatchesCutoff(
              target.topicId,
              access.topic.created_at,
              params.createdAfter,
            )
          ) {
            completedScopes.push(
              `${targetScope(target)}:filtered:createdAfter`,
            );
            continue;
          }
          if (progress.collectedTopics >= maxTopics) {
            completedScopes.push(limitedScope(target, maxTopics));
            for (const remainingTarget of targets.slice(index + 1)) {
              completedScopes.push(unvisitedScope(remainingTarget, maxTopics));
            }
            break;
          }
          await collectTopicContent(
            context,
            page,
            request,
            site,
            target.topicId,
            completedScopes,
            access,
          );
          progress.collectedTopics += 1;
          completedScopes.push(targetScope(target));
          continue;
        }
        const result = await collectListTarget(
          context,
          page,
          request,
          site,
          target,
          maxTopics,
          params.createdAfter,
          progress,
          completedScopes,
        );
        if (result === "limited") {
          completedScopes.push(limitedScope(target, maxTopics));
          for (const remainingTarget of targets.slice(index + 1)) {
            completedScopes.push(unvisitedScope(remainingTarget, maxTopics));
          }
          break;
        }
      }
      return { completedScopes };
    });
  } catch (error) {
    throw failureWithProgress(error, context, completedScopes);
  }
}

export const sourceAdapter = defineSourceAdapter({
  id: "binny.source-adapter-linuxdo",
  version: "1.0.0",
  description: "按长期主题目标发现并归档 Linux.do 帖子与媒体。",
  environment: {
    browser: { required: true, profileReuseAfterRestart: true },
  },
  configSchema: sourceAdapterConfigSchema,
  actions: {
    check: defineSourceAdapterCheckAction({
      description: "检查登录状态以及所选 Linux.do 目标的可见范围。",
      params: checkParamsSchema,
      execute: checkTopic,
    }),
    collect: defineSourceAdapterAction({
      description: "发现所选 Linux.do 目标的主题并归档帖子、回复和媒体。",
      params: collectParamsSchema,
      execute: collectTopic,
    }),
  },
});
