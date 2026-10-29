import * as z from "zod";

export type ValidationFailure = {
  readonly error: {
    readonly code: "invalid_input";
    readonly message: string;
    readonly path?: (string | number)[];
  };
};

/**
 * 将契约校验问题转换成统一的中文 API 错误，同时保留字段路径和已有业务说明。
 */
export function validationFailure(
  issues: readonly z.core.$ZodIssue[],
): ValidationFailure {
  const firstIssue = issues[0];
  const path = firstIssue?.path.map((part) =>
    typeof part === "symbol" ? String(part) : part,
  );
  const message =
    firstIssue?.code === "unrecognized_keys"
      ? "请求包含未支持的字段。"
      : firstIssue?.code === "invalid_type"
        ? "必填字段缺失或字段类型无效。"
        : firstIssue?.message.includes("。") === true
          ? firstIssue.message
          : "字段值不符合要求。";
  return {
    error: {
      code: "invalid_input",
      message,
      ...(path === undefined || path.length === 0 ? {} : { path }),
    },
  };
}
