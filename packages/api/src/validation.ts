import * as z from "zod";

export type ValidationFailure = {
  readonly error: {
    readonly code: "invalid_input";
    readonly message: string;
    readonly path?: (string | number)[];
  };
};

export type ValidationFailureOptions = {
  readonly preserveOriginalMessage?: boolean;
};

function nestedIssues(
  issues: readonly z.core.$ZodIssue[],
): readonly z.core.$ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" && issue.errors.length > 0
      ? nestedIssues(issue.errors.flat())
      : [issue],
  );
}

/** Preserve field paths and actionable messages when reporting contract failures. */
export function validationFailure(
  issues: readonly z.core.$ZodIssue[],
  options: ValidationFailureOptions = {},
): ValidationFailure {
  const firstIssue = issues[0];
  const explicitExtensionScopeIssue = nestedIssues(issues).find(
    (issue) =>
      issue.path.length === 1 &&
      issue.path[0] === "bins" &&
      issue.message === "Extension filters require an explicit bin scope.",
  );
  const issue = explicitExtensionScopeIssue ?? firstIssue;
  const path = issue?.path.map((part) =>
    typeof part === "symbol" ? String(part) : part,
  );
  const message =
    options.preserveOriginalMessage === true
      ? (issue?.message ?? "字段值不符合要求。")
      : (explicitExtensionScopeIssue?.message ??
        (issue?.code === "unrecognized_keys"
          ? "请求包含未支持的字段。"
          : issue?.code === "invalid_type"
            ? "必填字段缺失或字段类型无效。"
            : issue?.message.includes("。") === true ||
                issue?.message.endsWith(".") === true
              ? issue.message
              : "字段值不符合要求。"));
  return {
    error: {
      code: "invalid_input",
      message,
      ...(path === undefined || path.length === 0 ? {} : { path }),
    },
  };
}
