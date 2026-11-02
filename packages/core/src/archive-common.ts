import type { ArchiveError, ArchiveOperation } from "@binny/contracts";

export function failure<T>(
  status: 400 | 404 | 409 | 503,
  code: ArchiveError["code"],
  message: string,
  path?: readonly (string | number)[],
): ArchiveOperation<T> {
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

export function validationFailure<T>(
  issues: readonly {
    readonly message: string;
    readonly path: readonly PropertyKey[];
  }[],
): ArchiveOperation<T> {
  const issue = issues[0];
  return failure(
    400,
    "invalid_input",
    issue?.message ?? "归档请求格式无效。",
    issue?.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON 数字必须是有限值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("归档状态必须是 JSON 值。");
}

export function isoTimestamp(value: Date): string {
  return value.toISOString();
}

export function optionalText(
  name: "runId" | "sourceAdapterVersion",
  value: string | null,
): { readonly runId?: string; readonly sourceAdapterVersion?: string } {
  if (value === null) return {};
  return name === "runId" ? { runId: value } : { sourceAdapterVersion: value };
}
