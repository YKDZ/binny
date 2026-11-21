import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  sourceAdapterManifestStoredSchema,
  humanSessionFailureSchema,
  humanSessionSchema,
  runtimeHeartbeatTimeoutMs,
  runtimeProtocolVersion,
  runtimeWakeErrorSchema,
  type HumanSession,
  type HumanSessionApiError,
  type HumanSessionOperation,
  type HumanSessionOperations,
  type HumanSessionStatus,
  type RuntimeHumanSessionControl,
  type RuntimeHumanSessionEvent,
  type RuntimeWakeError,
} from "@binny/contracts";
import {
  binConfigurations,
  humanSessions,
  manualRuns,
  runtimeConnections,
  runtimeContainers,
  type Database,
  type Transaction,
} from "@binny/db";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { isRuntimeBrowserBusy } from "./manual-run-fencing.ts";
import type { RuntimeContainerCoordinator } from "./runtime-container.ts";

const activeStatuses = ["pending", "opening", "ready", "closing"] as const;

type SessionRow = typeof humanSessions.$inferSelect;

export type HumanSessionStore = HumanSessionOperations & {
  authorizeHumanTunnel(
    sessionId: string,
    binId: string,
    runtimeId: string,
    ownerGeneration: string,
    token: string,
  ): Promise<boolean>;
  authorizeHumanViewer(sessionId: string, token: string): Promise<boolean>;
  markHumanGatewayClosed(sessionId: string): Promise<void>;
  expirePendingHumanSessions(maxAgeMs: number): Promise<number>;
  beginHumanGatewayShutdown(): Promise<void>;
  reconcileHumanSessionsAfterGatewayRestart(): Promise<void>;
};

function failure<T>(
  status: 400 | 404 | 409,
  code: HumanSessionApiError["code"],
  message: string,
  path?: readonly (string | number)[],
): HumanSessionOperation<T> {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path: [...path] }),
    },
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseWakeError(raw: unknown): RuntimeWakeError | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = runtimeWakeErrorSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function rowToSession(
  database: Database | Transaction,
  row: SessionRow,
): Promise<HumanSession> {
  const failure =
    row.failure === null
      ? undefined
      : humanSessionFailureSchema.parse(row.failure);
  let queueReason: HumanSession["queueReason"];
  let lastWakeError: RuntimeWakeError | undefined;
  if (row.status === "pending") {
    const [activeRun] = await database
      .select({ runId: manualRuns.runId })
      .from(manualRuns)
      .where(
        and(
          eq(manualRuns.binId, row.binId),
          or(
            inArray(manualRuns.status, ["executing", "cancelling"]),
            and(
              isNotNull(manualRuns.startedAt),
              isNull(manualRuns.stopConfirmedAt),
            ),
          ),
        ),
      )
      .limit(1);
    if (activeRun !== undefined) {
      queueReason = "bin_busy";
    } else {
      const [[owner], [container]] = await Promise.all([
        database
          .select({
            protocolVersion: runtimeConnections.protocolVersion,
            environment: runtimeConnections.environment,
            online: exists(
              database
                .select({ binId: runtimeConnections.binId })
                .from(runtimeConnections)
                .where(
                  and(
                    eq(runtimeConnections.binId, row.binId),
                    eq(runtimeConnections.disconnected, false),
                    eq(runtimeConnections.ownerState, "confirmed"),
                    gt(
                      runtimeConnections.lastHeartbeatAt,
                      sql`now() - ${runtimeHeartbeatTimeoutMs} * interval '1 millisecond'`,
                    ),
                  ),
                ),
            ),
          })
          .from(runtimeConnections)
          .where(eq(runtimeConnections.binId, row.binId)),
        database
          .select({
            lifecyclePhase: runtimeContainers.lifecyclePhase,
            lastWakeError: runtimeContainers.lastWakeError,
          })
          .from(runtimeContainers)
          .where(eq(runtimeContainers.binId, row.binId)),
      ]);
      if (
        container?.lifecyclePhase === "stopping" ||
        container?.lifecyclePhase === "sleeping"
      ) {
        queueReason = "runtime_sleeping";
        lastWakeError = parseWakeError(container.lastWakeError);
      } else if (
        container?.lifecyclePhase === "waking" &&
        (owner === undefined || !owner.online)
      ) {
        queueReason = "runtime_waking";
        lastWakeError = parseWakeError(container.lastWakeError);
      } else if (owner === undefined || !owner.online) {
        queueReason = "runtime_offline";
        lastWakeError = parseWakeError(container?.lastWakeError);
      } else if (owner.protocolVersion < runtimeProtocolVersion) {
        queueReason = "runtime_protocol_outdated";
      } else if (isRuntimeBrowserBusy(owner.environment)) {
        queueReason = "bin_busy";
      }
    }
  }
  return humanSessionSchema.parse({
    sessionId: row.sessionId,
    binId: row.binId,
    status: row.status,
    ...(queueReason === undefined ? {} : { queueReason }),
    ...(lastWakeError === undefined ? {} : { lastWakeError }),
    requestedAt: row.requestedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.readyAt === null ? {} : { readyAt: row.readyAt.toISOString() }),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt.toISOString() }),
    ...(failure === undefined ? {} : { failure }),
  });
}

function closingStatus(
  status: HumanSessionStatus,
  gatewayClosed: boolean,
  runtimeClosed: boolean,
): HumanSessionStatus {
  if (!gatewayClosed || !runtimeClosed) return "closing";
  return status === "failed" ? "failed" : "closed";
}

async function readActiveSession(
  database: Database | Transaction,
  binId: string,
): Promise<SessionRow | undefined> {
  const [row] = await database
    .select()
    .from(humanSessions)
    .where(
      and(
        eq(humanSessions.binId, binId),
        inArray(humanSessions.status, activeStatuses),
      ),
    )
    .limit(1);
  return row;
}

export async function hasActiveHumanSession(
  database: Database | Transaction,
  binId: string,
): Promise<boolean> {
  return (await readActiveSession(database, binId)) !== undefined;
}

export async function applyRuntimeHumanSessionHeartbeat(
  transaction: Transaction,
  options: {
    readonly binId: string;
    readonly runtimeId: string;
    readonly ownerGeneration: string;
    readonly ownerConfirmed: boolean;
    readonly runtimeEnvironment: unknown;
    readonly event?: RuntimeHumanSessionEvent;
  },
): Promise<{
  readonly control?: RuntimeHumanSessionControl;
  readonly terminated: boolean;
}> {
  let session = await readActiveSession(transaction, options.binId);
  if (session === undefined) return { terminated: false };

  let terminated = false;
  const generation = BigInt(options.ownerGeneration);
  const ownsSession =
    session.runtimeId === options.runtimeId &&
    session.ownerGeneration === generation;
  const event = options.event;
  if (event !== undefined && event.sessionId === session.sessionId) {
    if (
      event.event === "ready" &&
      session.status === "opening" &&
      ownsSession
    ) {
      await transaction
        .update(humanSessions)
        .set({
          status: "ready",
          runtimeTokenHash: null,
          readyAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    } else if (
      event.event === "expired" &&
      session.status === "ready" &&
      ownsSession
    ) {
      await transaction
        .update(humanSessions)
        .set({
          status: "closing",
          runtimeTokenHash: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    } else if (
      event.event === "failed" &&
      (session.status === "opening" || session.status === "ready") &&
      ownsSession
    ) {
      const failure = humanSessionFailureSchema.parse(
        event.failure ?? {
          code: "browser_session_failed",
          message: "浏览器人工会话没有完成启动。",
        },
      );
      const nextStatus = closingStatus("failed", session.gatewayClosed, true);
      if (nextStatus === "failed") terminated = true;
      await transaction
        .update(humanSessions)
        .set({
          status: nextStatus,
          runtimeClosed: true,
          runtimeTokenHash: null,
          failure,
          updatedAt: sql`clock_timestamp()`,
          ...(session.gatewayClosed
            ? { closedAt: sql`clock_timestamp()` }
            : {}),
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    } else if (
      event.event === "closed" &&
      session.status === "closing" &&
      (ownsSession || options.ownerConfirmed)
    ) {
      const nextStatus = closingStatus(
        session.status,
        session.gatewayClosed,
        true,
      );
      if (nextStatus === "closed") terminated = true;
      await transaction
        .update(humanSessions)
        .set({
          status: nextStatus,
          runtimeClosed: true,
          runtimeTokenHash: null,
          updatedAt: sql`clock_timestamp()`,
          ...(nextStatus === "closed"
            ? { closedAt: sql`clock_timestamp()` }
            : {}),
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    }
    session = (await readActiveSession(transaction, options.binId)) ?? session;
  }

  if (
    session.status === "opening" &&
    (session.runtimeId !== options.runtimeId ||
      session.ownerGeneration !== generation)
  ) {
    await transaction
      .update(humanSessions)
      .set({
        status: "closing",
        runtimeTokenHash: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(humanSessions.sessionId, session.sessionId));
    session = (await readActiveSession(transaction, options.binId)) ?? session;
  } else if (
    session.status === "ready" &&
    (session.runtimeId !== options.runtimeId ||
      session.ownerGeneration !== generation)
  ) {
    await transaction
      .update(humanSessions)
      .set({
        status: "closing",
        runtimeTokenHash: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(humanSessions.sessionId, session.sessionId));
    session = (await readActiveSession(transaction, options.binId)) ?? session;
  }

  if (session.status === "pending" && options.ownerConfirmed) {
    const [activeRun] = await transaction
      .select({ runId: manualRuns.runId })
      .from(manualRuns)
      .where(
        and(
          eq(manualRuns.binId, options.binId),
          or(
            inArray(manualRuns.status, ["executing", "cancelling"]),
            and(
              isNotNull(manualRuns.startedAt),
              isNull(manualRuns.stopConfirmedAt),
            ),
          ),
        ),
      )
      .limit(1);
    if (
      activeRun === undefined &&
      !isRuntimeBrowserBusy(options.runtimeEnvironment)
    ) {
      await transaction
        .update(humanSessions)
        .set({
          status: "opening",
          runtimeId: options.runtimeId,
          ownerGeneration: generation,
          gatewayClosed: false,
          runtimeClosed: false,
          failure: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      session =
        (await readActiveSession(transaction, options.binId)) ?? session;
    }
  }

  if (session.status === "opening" && options.ownerConfirmed) {
    if (isRuntimeBrowserBusy(options.runtimeEnvironment)) return { terminated };
    const tunnelToken = randomBytes(32).toString("base64url");
    await transaction
      .update(humanSessions)
      .set({
        runtimeTokenHash: tokenHash(tunnelToken),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(humanSessions.sessionId, session.sessionId));
    return {
      control: {
        sessionId: session.sessionId,
        action: "open",
        tunnelToken,
      },
      terminated,
    };
  }
  if (session.status === "closing") {
    return {
      control: {
        sessionId: session.sessionId,
        action: "close",
      },
      terminated,
    };
  }
  return { terminated };
}

export function createHumanSessionStore(
  database: Database,
  options?: { readonly containerCoordinator?: RuntimeContainerCoordinator },
): HumanSessionStore {
  const containerCoordinator = options?.containerCoordinator;
  return {
    async requestHumanSession(binId) {
      const result = await database.transaction<
        HumanSessionOperation<HumanSession & { readonly viewerPath: string }>
      >(async (transaction) => {
        const [bin] = await transaction
          .select({
            id: binConfigurations.id,
            sourceAdapter: binConfigurations.sourceAdapter,
          })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);

        const manifest = sourceAdapterManifestStoredSchema.parse(
          bin.sourceAdapter,
        );
        if (!manifest.environment.browser.required)
          return failure(
            409,
            "browser_not_required",
            "这个信源适配器没有声明需要浏览器环境。",
            ["binId"],
          );

        if (await readActiveSession(transaction, binId))
          return failure(
            409,
            "human_session_active",
            "这个 bin 已有待处理或正在使用的浏览器人工会话。",
            ["binId"],
          );

        const sessionId = randomUUID();
        const accessToken = randomBytes(32).toString("base64url");
        const [row] = await transaction
          .insert(humanSessions)
          .values({
            sessionId,
            binId,
            accessTokenHash: tokenHash(accessToken),
          })
          .returning();
        if (row === undefined)
          throw new Error("浏览器人工会话创建后没有返回记录。");
        return {
          ok: true,
          value: {
            ...(await rowToSession(transaction, row)),
            viewerPath:
              "/human-sessions/" +
              sessionId +
              "?token=" +
              encodeURIComponent(accessToken),
          },
        };
      });
      if (result.ok) {
        containerCoordinator?.requestWake(binId);
      }
      return result;
    },

    async getHumanSession(binId, sessionId) {
      const [row] = await database
        .select()
        .from(humanSessions)
        .where(
          and(
            eq(humanSessions.binId, binId),
            eq(humanSessions.sessionId, sessionId),
          ),
        );
      return row === undefined
        ? failure(
            404,
            "human_session_not_found",
            "没有找到这个浏览器人工会话。",
            ["sessionId"],
          )
        : {
            ok: true,
            value: await rowToSession(database, row),
          };
    },

    async closeHumanSession(binId, sessionId) {
      let closedPending = false;
      const result = await database.transaction<
        HumanSessionOperation<HumanSession>
      >(async (transaction) => {
        const [bin] = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(eq(binConfigurations.id, binId))
          .for("update");
        if (bin === undefined)
          return failure(404, "bin_not_found", "没有找到这个 bin。", ["binId"]);
        const [row] = await transaction
          .select()
          .from(humanSessions)
          .where(
            and(
              eq(humanSessions.binId, binId),
              eq(humanSessions.sessionId, sessionId),
            ),
          )
          .for("update");
        if (row === undefined)
          return failure(
            404,
            "human_session_not_found",
            "没有找到这个浏览器人工会话。",
            ["sessionId"],
          );
        if (row.status === "pending") {
          closedPending = true;
          const [closed] = await transaction
            .update(humanSessions)
            .set({
              status: "closed",
              gatewayClosed: true,
              runtimeClosed: true,
              runtimeTokenHash: null,
              updatedAt: sql`clock_timestamp()`,
              closedAt: sql`clock_timestamp()`,
            })
            .where(eq(humanSessions.sessionId, sessionId))
            .returning();
          if (closed === undefined)
            throw new Error("待处理的浏览器人工会话没有关闭记录。");
          return {
            ok: true as const,
            value: await rowToSession(transaction, closed),
          };
        }
        const [updated] = await transaction
          .update(humanSessions)
          .set({
            status:
              row.status === "closed" || row.status === "failed"
                ? row.status
                : "closing",
            runtimeTokenHash: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(humanSessions.sessionId, sessionId))
          .returning();
        if (updated === undefined)
          throw new Error("浏览器人工会话关闭请求没有返回记录。");
        return {
          ok: true as const,
          value: await rowToSession(transaction, updated),
        };
      });
      if (result.ok && closedPending) {
        await containerCoordinator?.markWorkCompleted(binId);
      }
      return result;
    },

    async authorizeHumanTunnel(
      sessionId,
      binId,
      runtimeId,
      ownerGeneration,
      token,
    ) {
      const [row] = await database
        .select({
          status: humanSessions.status,
          binId: humanSessions.binId,
          runtimeId: humanSessions.runtimeId,
          ownerGeneration: humanSessions.ownerGeneration,
          runtimeTokenHash: humanSessions.runtimeTokenHash,
        })
        .from(humanSessions)
        .where(eq(humanSessions.sessionId, sessionId));
      return (
        row?.status === "opening" &&
        row.binId === binId &&
        row.runtimeId === runtimeId &&
        row.ownerGeneration === BigInt(ownerGeneration) &&
        row.runtimeTokenHash !== null &&
        timingSafeEqual(
          Buffer.from(row.runtimeTokenHash, "hex"),
          Buffer.from(tokenHash(token), "hex"),
        )
      );
    },

    async authorizeHumanViewer(sessionId, token) {
      const [row] = await database
        .select({
          status: humanSessions.status,
          accessTokenHash: humanSessions.accessTokenHash,
        })
        .from(humanSessions)
        .where(eq(humanSessions.sessionId, sessionId));
      if (row?.status !== "ready") return false;
      const stored = Buffer.from(row.accessTokenHash, "hex");
      const supplied = Buffer.from(tokenHash(token), "hex");
      return (
        stored.length === supplied.length && timingSafeEqual(stored, supplied)
      );
    },

    async markHumanGatewayClosed(sessionId) {
      let terminatedBinId: string | undefined;
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({
            binId: humanSessions.binId,
            status: humanSessions.status,
            gatewayClosed: humanSessions.gatewayClosed,
            runtimeClosed: humanSessions.runtimeClosed,
          })
          .from(humanSessions)
          .where(eq(humanSessions.sessionId, sessionId))
          .for("update");
        if (row === undefined || row.status === "closed") return;
        if (row.status !== "closing" && row.status !== "failed") return;
        const status = closingStatus(row.status, true, row.runtimeClosed);
        if (status === "closed" || status === "failed") {
          terminatedBinId = row.binId;
        }
        await transaction
          .update(humanSessions)
          .set({
            status,
            gatewayClosed: true,
            runtimeTokenHash: null,
            updatedAt: sql`clock_timestamp()`,
            ...(status === "closed" || status === "failed"
              ? { closedAt: sql`clock_timestamp()` }
              : {}),
          })
          .where(eq(humanSessions.sessionId, sessionId));
      });
      if (terminatedBinId !== undefined) {
        await containerCoordinator?.markWorkCompleted(terminatedBinId);
      }
    },

    async expirePendingHumanSessions(maxAgeMs) {
      if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1)
        throw new Error("人工会话等待期限必须是正整数。");
      const expiredBinIds: string[] = [];
      const expiredCount = await database.transaction(async (transaction) => {
        const bins = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .innerJoin(
            humanSessions,
            eq(humanSessions.binId, binConfigurations.id),
          )
          .where(
            and(
              eq(humanSessions.status, "pending"),
              sql`${humanSessions.requestedAt} < clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
            ),
          )
          .orderBy(binConfigurations.id)
          .for("update");
        let expired = 0;
        for (const bin of bins) {
          const rows = await transaction
            .update(humanSessions)
            .set({
              status: "closed",
              gatewayClosed: true,
              runtimeClosed: true,
              runtimeTokenHash: null,
              updatedAt: sql`clock_timestamp()`,
              closedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(humanSessions.binId, bin.id),
                eq(humanSessions.status, "pending"),
                sql`${humanSessions.requestedAt} < clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
              ),
            )
            .returning({ sessionId: humanSessions.sessionId });
          if (rows.length > 0) {
            expired += rows.length;
            expiredBinIds.push(bin.id);
          }
        }
        return expired;
      });
      for (const binId of expiredBinIds) {
        await containerCoordinator?.markWorkCompleted(binId);
      }
      return expiredCount;
    },

    async beginHumanGatewayShutdown() {
      await database.transaction(async (transaction) => {
        const bins = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .innerJoin(
            humanSessions,
            eq(humanSessions.binId, binConfigurations.id),
          )
          .where(inArray(humanSessions.status, activeStatuses))
          .orderBy(binConfigurations.id)
          .for("update");
        for (const bin of bins) {
          await transaction
            .update(humanSessions)
            .set({
              status: "closing",
              runtimeTokenHash: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(humanSessions.binId, bin.id),
                inArray(humanSessions.status, activeStatuses),
              ),
            );
        }
      });
    },

    async reconcileHumanSessionsAfterGatewayRestart() {
      await database.transaction(async (transaction) => {
        const bins = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .innerJoin(
            humanSessions,
            eq(humanSessions.binId, binConfigurations.id),
          )
          .where(inArray(humanSessions.status, activeStatuses))
          .orderBy(binConfigurations.id)
          .for("update");
        for (const bin of bins) {
          await transaction
            .update(humanSessions)
            .set({
              status: "closing",
              gatewayClosed: true,
              runtimeTokenHash: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(humanSessions.binId, bin.id),
                inArray(humanSessions.status, activeStatuses),
              ),
            );
        }
      });
    },
  };
}
