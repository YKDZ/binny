import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";

import type {
  ManagedContainerHealthStatus,
  ManagedContainerInspectResult,
  ManagedContainerStatus,
  RuntimeContainerDriver,
} from "@binny/core";

type DockerHttpResponse = {
  readonly status: number;
  readonly body: string;
};

type DockerContainerInspectPayload = {
  readonly Id?: unknown;
  readonly Config?: {
    readonly Env?: unknown;
    readonly Labels?: unknown;
  };
  readonly State?: {
    readonly Status?: unknown;
    readonly ExitCode?: unknown;
    readonly OOMKilled?: unknown;
    readonly StartedAt?: unknown;
    readonly FinishedAt?: unknown;
    readonly Health?: {
      readonly Status?: unknown;
    };
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<
      string,
      ReadonlyArray<{
        readonly HostIp?: unknown;
        readonly HostPort?: unknown;
      }> | null
    >;
  };
};

type DockerContainerListItem = {
  readonly Id?: unknown;
};

const managedRuntimeLabelKey = "io.binny.managed-runtime";
const composeProjectLabelKey = "com.docker.compose.project";
const composeServiceLabelKey = "com.docker.compose.service";
const composeOneOffLabelKey = "com.docker.compose.oneoff";

function dockerUnixRequest(
  socketPath: string,
  method: "GET" | "POST",
  requestPath: string,
  timeoutMs: number,
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path: requestPath,
        headers: {
          host: "docker",
          ...(method === "POST" ? { "content-length": "0" } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `Docker Engine request timed out (${method} ${requestPath}).`,
        ),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function readEnvironmentValue(
  envList: unknown,
  key: string,
): string | undefined {
  if (!Array.isArray(envList)) return undefined;
  const prefix = `${key}=`;
  for (const item of envList) {
    if (typeof item === "string" && item.startsWith(prefix)) {
      const value = item.slice(prefix.length).trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

function readLabels(labels: unknown): Record<string, string> {
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function normalizeContainerStatus(raw: unknown): ManagedContainerStatus {
  switch (raw) {
    case "created":
    case "running":
    case "paused":
    case "restarting":
    case "removing":
    case "exited":
    case "dead":
      return raw;
    default:
      return "dead";
  }
}

function normalizeHealthStatus(raw: unknown): ManagedContainerHealthStatus {
  switch (raw) {
    case "starting":
    case "healthy":
    case "unhealthy":
      return raw;
    default:
      return "none";
  }
}

function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("0001-01-01T")) return null;
  return raw;
}

function parseVncHostPort(
  payload: DockerContainerInspectPayload,
  status: ManagedContainerStatus,
): number | null {
  if (status !== "running") return null;
  const bindings = payload.NetworkSettings?.Ports?.["5900/tcp"];
  if (!Array.isArray(bindings) || bindings.length === 0) return null;
  const preferred =
    bindings.find(
      (entry) =>
        entry.HostIp === "0.0.0.0" &&
        typeof entry.HostPort === "string" &&
        entry.HostPort.length > 0,
    ) ??
    bindings.find(
      (entry) =>
        typeof entry.HostPort === "string" && entry.HostPort.length > 0,
    );
  if (preferred === undefined || typeof preferred.HostPort !== "string") {
    return null;
  }
  const parsed = Number(preferred.HostPort);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : null;
}

function parseManagedInspectResult(
  payload: DockerContainerInspectPayload,
  expectedComposeProject: string,
): ManagedContainerInspectResult | null {
  if (typeof payload.Id !== "string" || payload.Id.length === 0) return null;
  const labels = readLabels(payload.Config?.Labels);
  if (labels[composeProjectLabelKey] !== expectedComposeProject) return null;
  if (labels[managedRuntimeLabelKey] !== "true") return null;
  if (labels[composeOneOffLabelKey] === "True") return null;

  const composeService = labels[composeServiceLabelKey];
  if (composeService === undefined || composeService.length === 0) return null;

  const binId = readEnvironmentValue(payload.Config?.Env, "BINNY_BIN_ID");
  if (binId === undefined) return null;

  const state = payload.State ?? {};
  const status = normalizeContainerStatus(state.Status);
  return {
    containerId: payload.Id,
    composeProject: expectedComposeProject,
    composeService,
    binId,
    status,
    exitCode: typeof state.ExitCode === "number" ? state.ExitCode : 0,
    oomKilled: state.OOMKilled === true,
    startedAt: normalizeTimestamp(state.StartedAt),
    finishedAt: normalizeTimestamp(state.FinishedAt),
    healthStatus: normalizeHealthStatus(state.Health?.Status),
    vncHostPort: parseVncHostPort(payload, status),
  };
}

function parseDockerErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { readonly message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // Ignore non-JSON bodies from Docker Engine.
  }
  return body.trim() || fallback;
}

async function resolveComposeProject(
  socketPath: string,
): Promise<string | undefined> {
  const explicit = process.env.BINNY_COMPOSE_PROJECT?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const selfId = hostname().trim();
  if (selfId.length === 0) return undefined;
  try {
    const response = await dockerUnixRequest(
      socketPath,
      "GET",
      `/containers/${encodeURIComponent(selfId)}/json`,
      5_000,
    );
    if (response.status !== 200) return undefined;
    const payload = JSON.parse(response.body) as DockerContainerInspectPayload;
    const labels = readLabels(payload.Config?.Labels);
    const project = labels[composeProjectLabelKey]?.trim();
    return project !== undefined && project.length > 0 ? project : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a Docker Engine Unix-socket container driver scoped strictly to the
 * current Compose project and containers labeled `io.binny.managed-runtime=true`.
 * Returns `undefined` when Docker socket or Compose project context is absent.
 */
export async function createDockerEngineContainerDriver(): Promise<
  RuntimeContainerDriver | undefined
> {
  const configuredSocket = process.env.BINNY_DOCKER_SOCKET_PATH;
  if (configuredSocket === "") return undefined;
  const socketPath = configuredSocket ?? "/var/run/docker.sock";

  try {
    await access(socketPath, constants.R_OK | constants.W_OK);
  } catch {
    return undefined;
  }

  const composeProject = await resolveComposeProject(socketPath);
  if (composeProject === undefined) return undefined;

  async function inspectManaged(
    containerId: string,
  ): Promise<ManagedContainerInspectResult | null> {
    const response = await dockerUnixRequest(
      socketPath,
      "GET",
      `/containers/${encodeURIComponent(containerId)}/json`,
      10_000,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(
        `Docker inspect failed (${response.status}): ${parseDockerErrorMessage(response.body, "unknown error")}`,
      );
    }
    const payload = JSON.parse(response.body) as DockerContainerInspectPayload;
    return parseManagedInspectResult(payload, composeProject!);
  }

  return {
    async discoverManagedContainers() {
      const filters = JSON.stringify({
        label: [
          `${composeProjectLabelKey}=${composeProject}`,
          `${managedRuntimeLabelKey}=true`,
        ],
      });
      const response = await dockerUnixRequest(
        socketPath,
        "GET",
        `/containers/json?all=1&filters=${encodeURIComponent(filters)}`,
        10_000,
      );
      if (response.status !== 200) {
        throw new Error(
          `Docker container discovery failed (${response.status}): ${parseDockerErrorMessage(response.body, "unknown error")}`,
        );
      }
      const items = JSON.parse(
        response.body,
      ) as readonly DockerContainerListItem[];
      const results: ManagedContainerInspectResult[] = [];
      for (const item of items) {
        if (typeof item.Id !== "string" || item.Id.length === 0) continue;
        const inspected = await inspectManaged(item.Id);
        if (inspected !== null) results.push(inspected);
      }
      return results;
    },

    inspectContainer: inspectManaged,

    async startContainer(containerId) {
      const inspected = await inspectManaged(containerId);
      if (inspected === null) return "not_found";
      const response = await dockerUnixRequest(
        socketPath,
        "POST",
        `/containers/${encodeURIComponent(containerId)}/start`,
        30_000,
      );
      if (response.status === 204) return "started";
      if (response.status === 304) return "already_running";
      if (response.status === 404) return "not_found";
      throw new Error(
        `Docker start failed (${response.status}): ${parseDockerErrorMessage(response.body, "unknown error")}`,
      );
    },

    async stopContainer(containerId, graceSeconds = 30) {
      const inspected = await inspectManaged(containerId);
      if (inspected === null) return "not_found";
      const timeoutParam = Math.max(0, Math.trunc(graceSeconds));
      const response = await dockerUnixRequest(
        socketPath,
        "POST",
        `/containers/${encodeURIComponent(containerId)}/stop?t=${timeoutParam}`,
        (timeoutParam + 15) * 1_000,
      );
      if (response.status === 204) return "stopped";
      if (response.status === 304) return "already_stopped";
      if (response.status === 404) return "not_found";
      throw new Error(
        `Docker stop failed (${response.status}): ${parseDockerErrorMessage(response.body, "unknown error")}`,
      );
    },
  };
}
