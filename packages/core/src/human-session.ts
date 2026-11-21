import { randomInt, randomUUID } from "node:crypto";

import {
  sourceAdapterManifestStoredSchema,
  humanSessionFailureSchema,
  humanSessionSchema,
  runtimeHeartbeatTimeoutMs,
  runtimeProtocolVersion,
  type HumanSession,
  type HumanSessionApiError,
  type HumanSessionCreated,
  type HumanSessionOperation,
  type HumanSessionOperations,
  type RuntimeActiveHumanSession,
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
import {
  parseContainerWakeError,
  type RuntimeContainerCoordinator,
} from "./runtime-container.ts";

const activeStatuses = ["pending", "opening", "ready", "closing"] as const;
const defaultConnectTimeoutMs = 60_000;
const vncPasswordAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

type SessionRow = typeof humanSessions.$inferSelect;

export type HumanSessionStore = HumanSessionOperations & {
  expirePendingHumanSessions(maxAgeMs: number): Promise<number>;
};

export function generateVncPassword(): string {
  let password = "";
  for (let index = 0; index < 8; index += 1) {
    password += vncPasswordAlphabet[randomInt(0, vncPasswordAlphabet.length)]!;
  }
  return password;
}

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

async function rowToSession(
  database: Database | Transaction,
  row: SessionRow,
  resolveRuntimeVncHostPort?: (binId: string) => Promise<number | null>,
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
        lastWakeError = parseContainerWakeError(container.lastWakeError);
      } else if (
        container?.lifecyclePhase === "waking" &&
        (owner === undefined || !owner.online)
      ) {
        queueReason = "runtime_waking";
        lastWakeError = parseContainerWakeError(container.lastWakeError);
      } else if (owner === undefined || !owner.online) {
        queueReason = "runtime_offline";
        lastWakeError = parseContainerWakeError(container?.lastWakeError);
      } else if (owner.protocolVersion < runtimeProtocolVersion) {
        queueReason = "runtime_protocol_outdated";
      } else if (isRuntimeBrowserBusy(owner.environment)) {
        queueReason = "bin_busy";
      }
    }
  }
  const hostPort =
    row.status === "ready" && resolveRuntimeVncHostPort !== undefined
      ? await resolveRuntimeVncHostPort(row.binId)
      : null;
  return humanSessionSchema.parse({
    sessionId: row.sessionId,
    binId: row.binId,
    status: row.status,
    ...(queueReason === undefined ? {} : { queueReason }),
    ...(lastWakeError === undefined ? {} : { lastWakeError }),
    ...(hostPort === null ? {} : { port: hostPort }),
    requestedAt: row.requestedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.readyAt === null ? {} : { readyAt: row.readyAt.toISOString() }),
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt.toISOString() }),
    ...(failure === undefined ? {} : { failure }),
  });
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

/**
 * Settles active runtime-bound human sessions when a runtime container is
 * discovered offline or exited before closing the session cleanly.
 */
export async function settleDisconnectedRuntimeHumanSessions(
  transaction: Transaction,
  binId: string,
): Promise<void> {
  const session = await readActiveSession(transaction, binId);
  if (session === undefined || session.status === "pending") return;
  if (session.status === "closing") {
    await transaction
      .update(humanSessions)
      .set({
        status: "closed",
        runtimeClosed: true,
        vncPasswordPending: null,
        updatedAt: sql`clock_timestamp()`,
        closedAt: sql`clock_timestamp()`,
      })
      .where(eq(humanSessions.sessionId, session.sessionId));
    return;
  }
  await transaction
    .update(humanSessions)
    .set({
      status: "failed",
      runtimeClosed: true,
      vncPasswordPending: null,
      failure: {
        code: "runtime_disconnected",
        message: "Runtime container stopped before the human session closed.",
      },
      updatedAt: sql`clock_timestamp()`,
      closedAt: sql`clock_timestamp()`,
    })
    .where(eq(humanSessions.sessionId, session.sessionId));
}

export async function applyRuntimeHumanSessionHeartbeat(
  transaction: Transaction,
  options: {
    readonly binId: string;
    readonly runtimeId: string;
    readonly ownerGeneration: string;
    readonly ownerConfirmed: boolean;
    readonly runtimeEnvironment: unknown;
    readonly connectTimeoutMs?: number;
    readonly activeHumanSession?: RuntimeActiveHumanSession | null;
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
          vncPasswordPending: null,
          readyAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    } else if (
      event.event === "expired" &&
      (session.status === "opening" ||
        session.status === "ready" ||
        session.status === "closing") &&
      ownsSession
    ) {
      terminated = true;
      await transaction
        .update(humanSessions)
        .set({
          status: "closed",
          runtimeClosed: true,
          vncPasswordPending: null,
          updatedAt: sql`clock_timestamp()`,
          closedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      return { terminated };
    } else if (
      event.event === "failed" &&
      (session.status === "opening" ||
        session.status === "ready" ||
        session.status === "closing") &&
      ownsSession
    ) {
      const failure = humanSessionFailureSchema.parse(
        event.failure ?? {
          code: "browser_session_failed",
          message: "Browser human session failed to start.",
        },
      );
      terminated = true;
      await transaction
        .update(humanSessions)
        .set({
          status: "failed",
          runtimeClosed: true,
          vncPasswordPending: null,
          failure,
          updatedAt: sql`clock_timestamp()`,
          closedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      return { terminated };
    } else if (
      event.event === "closed" &&
      (session.status === "opening" ||
        session.status === "ready" ||
        session.status === "closing") &&
      (ownsSession || options.ownerConfirmed)
    ) {
      terminated = true;
      await transaction
        .update(humanSessions)
        .set({
          status: "closed",
          runtimeClosed: true,
          vncPasswordPending: null,
          updatedAt: sql`clock_timestamp()`,
          closedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      return { terminated };
    }
    session = (await readActiveSession(transaction, options.binId)) ?? session;
  }

  if (
    (session.status === "opening" ||
      session.status === "ready" ||
      session.status === "closing") &&
    !ownsSession
  ) {
    if (options.activeHumanSession !== undefined && options.ownerConfirmed) {
      await transaction
        .update(humanSessions)
        .set({
          status: "closed",
          runtimeClosed: true,
          vncPasswordPending: null,
          updatedAt: sql`clock_timestamp()`,
          closedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      return { terminated: true };
    }
    if (session.status !== "closing") {
      await transaction
        .update(humanSessions)
        .set({
          status: "closing",
          vncPasswordPending: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      session =
        (await readActiveSession(transaction, options.binId)) ?? session;
    }
  } else if (ownsSession && options.activeHumanSession !== undefined) {
    if (options.activeHumanSession?.sessionId === session.sessionId) {
      if (
        session.status === "opening" &&
        options.activeHumanSession.phase === "ready"
      ) {
        await transaction
          .update(humanSessions)
          .set({
            status: "ready",
            vncPasswordPending: null,
            readyAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(humanSessions.sessionId, session.sessionId));
        session =
          (await readActiveSession(transaction, options.binId)) ?? session;
      } else if (session.status === "ready") {
        await transaction
          .update(humanSessions)
          .set({
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(humanSessions.sessionId, session.sessionId));
      }
    } else if (session.status === "ready" || session.status === "closing") {
      // Runtime reports no matching active VNC session; reconcile after server downtime.
      await transaction
        .update(humanSessions)
        .set({
          status: "closed",
          runtimeClosed: true,
          vncPasswordPending: null,
          updatedAt: sql`clock_timestamp()`,
          closedAt: sql`clock_timestamp()`,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
      return { terminated: true };
    }
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
    let password = session.vncPasswordPending;
    if (password === null) {
      password = generateVncPassword();
      await transaction
        .update(humanSessions)
        .set({
          vncPasswordPending: password,
        })
        .where(eq(humanSessions.sessionId, session.sessionId));
    }
    return {
      control: {
        sessionId: session.sessionId,
        action: "open",
        password,
        connectTimeoutMs: options.connectTimeoutMs ?? defaultConnectTimeoutMs,
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
  options?: {
    readonly containerCoordinator?: RuntimeContainerCoordinator;
    readonly resolveRuntimeVncHostPort?: (
      binId: string,
    ) => Promise<number | null>;
  },
): HumanSessionStore {
  const containerCoordinator = options?.containerCoordinator;
  const resolveRuntimeVncHostPort =
    options?.resolveRuntimeVncHostPort ??
    (containerCoordinator !== undefined
      ? (binId: string) => containerCoordinator.resolveVncHostPort(binId)
      : undefined);
  return {
    async requestHumanSession(binId) {
      const result = await database.transaction<
        HumanSessionOperation<HumanSessionCreated>
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
          return failure(404, "bin_not_found", "Bin not found.", ["binId"]);

        const manifest = sourceAdapterManifestStoredSchema.parse(
          bin.sourceAdapter,
        );
        if (!manifest.environment.browser.required)
          return failure(
            409,
            "browser_not_required",
            "Source adapter does not require a browser environment.",
            ["binId"],
          );

        if (await readActiveSession(transaction, binId))
          return failure(
            409,
            "human_session_active",
            "This bin already has an active or pending human session.",
            ["binId"],
          );

        const sessionId = randomUUID();
        const password = generateVncPassword();
        const [row] = await transaction
          .insert(humanSessions)
          .values({
            sessionId,
            binId,
            vncPasswordPending: password,
          })
          .returning();
        if (row === undefined)
          throw new Error("Human session insert returned no row.");
        return {
          ok: true,
          value: {
            ...(await rowToSession(
              transaction,
              row,
              resolveRuntimeVncHostPort,
            )),
            password,
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
        ? failure(404, "human_session_not_found", "Human session not found.", [
            "sessionId",
          ])
        : {
            ok: true,
            value: await rowToSession(database, row, resolveRuntimeVncHostPort),
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
          return failure(404, "bin_not_found", "Bin not found.", ["binId"]);
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
            "Human session not found.",
            ["sessionId"],
          );
        if (row.status === "pending") {
          closedPending = true;
          const [closed] = await transaction
            .update(humanSessions)
            .set({
              status: "closed",
              runtimeClosed: true,
              vncPasswordPending: null,
              updatedAt: sql`clock_timestamp()`,
              closedAt: sql`clock_timestamp()`,
            })
            .where(eq(humanSessions.sessionId, sessionId))
            .returning();
          if (closed === undefined)
            throw new Error("Pending human session close returned no row.");
          return {
            ok: true as const,
            value: await rowToSession(
              transaction,
              closed,
              resolveRuntimeVncHostPort,
            ),
          };
        }
        const [updated] = await transaction
          .update(humanSessions)
          .set({
            status:
              row.status === "closed" || row.status === "failed"
                ? row.status
                : "closing",
            vncPasswordPending: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(humanSessions.sessionId, sessionId))
          .returning();
        if (updated === undefined)
          throw new Error("Human session close update returned no row.");
        return {
          ok: true as const,
          value: await rowToSession(
            transaction,
            updated,
            resolveRuntimeVncHostPort,
          ),
        };
      });
      if (result.ok && closedPending) {
        await containerCoordinator?.markWorkCompleted(binId);
      }
      return result;
    },

    async expirePendingHumanSessions(maxAgeMs) {
      if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1)
        throw new Error(
          "Human session wait timeout must be a positive integer.",
        );
      const expiredBinIds: string[] = [];
      const expiredCount = await database.transaction(async (transaction) => {
        const candidates = await transaction
          .select({ binId: humanSessions.binId })
          .from(humanSessions)
          .where(
            or(
              and(
                eq(humanSessions.status, "pending"),
                sql`${humanSessions.requestedAt} <= clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
              ),
              and(
                eq(humanSessions.status, "opening"),
                sql`${humanSessions.updatedAt} <= clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
              ),
            ),
          );
        const candidateBinIds = [
          ...new Set(candidates.map((candidate) => candidate.binId)),
        ].toSorted();
        if (candidateBinIds.length === 0) return 0;
        const bins = await transaction
          .select({ id: binConfigurations.id })
          .from(binConfigurations)
          .where(inArray(binConfigurations.id, candidateBinIds))
          .orderBy(binConfigurations.id)
          .for("update");
        let expired = 0;
        for (const bin of bins) {
          const closedRows = await transaction
            .update(humanSessions)
            .set({
              status: "closed",
              runtimeClosed: true,
              vncPasswordPending: null,
              updatedAt: sql`clock_timestamp()`,
              closedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(humanSessions.binId, bin.id),
                eq(humanSessions.status, "pending"),
                sql`${humanSessions.requestedAt} <= clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
              ),
            )
            .returning({ sessionId: humanSessions.sessionId });
          if (closedRows.length > 0) {
            expired += closedRows.length;
            expiredBinIds.push(bin.id);
          }
          const closingRows = await transaction
            .update(humanSessions)
            .set({
              status: "closing",
              vncPasswordPending: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(humanSessions.binId, bin.id),
                eq(humanSessions.status, "opening"),
                sql`${humanSessions.updatedAt} <= clock_timestamp() - ${maxAgeMs} * interval '1 millisecond'`,
              ),
            )
            .returning({ sessionId: humanSessions.sessionId });
          if (closingRows.length > 0) {
            expired += closingRows.length;
          }
        }
        return expired;
      });
      for (const binId of expiredBinIds) {
        await containerCoordinator?.markWorkCompleted(binId);
      }
      return expiredCount;
    },
  };
}
