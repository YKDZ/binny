import {
  runtimeConfigurationValidationInputSchema,
  runtimeConfigurationValidationPath,
  runtimeConfigurationValidationResultSchema,
  runtimeControlUrlSchema,
  type BinError,
  type JsonObject,
  type SourceAdapterManifest,
} from "@binny/contracts";

export type RuntimeConfigurationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "invalid"; readonly error: BinError }
  | {
      readonly ok: false;
      readonly kind: "unavailable";
      readonly error: BinError;
    };

/** 请当前运行器执行适配器完整的原生配置解析。 */
export async function validateConfigurationAtRuntime(
  controlUrl: string,
  sourceAdapter: SourceAdapterManifest,
  config: JsonObject,
): Promise<RuntimeConfigurationValidation> {
  const checkedUrl = runtimeControlUrlSchema.safeParse(controlUrl);
  if (!checkedUrl.success) {
    return unavailable("运行器没有提供可用的内部控制地址。");
  }

  const checkedInput = runtimeConfigurationValidationInputSchema.safeParse({
    sourceAdapterId: sourceAdapter.id,
    sourceAdapterVersion: sourceAdapter.version,
    config,
  });
  if (!checkedInput.success) {
    return {
      ok: false,
      kind: "invalid",
      error: {
        code: "invalid_configuration",
        message: checkedInput.error.issues[0]?.message ?? "长期配置格式无效。",
        path: ["config"],
      },
    };
  }

  try {
    const response = await fetch(
      new URL(runtimeConfigurationValidationPath, checkedUrl.data),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checkedInput.data),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const result = runtimeConfigurationValidationResultSchema.safeParse(
      await response.json(),
    );
    if (!result.success) {
      return unavailable("运行器返回了无法识别的原生配置校验结果。");
    }
    if (result.data.valid) return { ok: true };
    if (result.data.error.code === "source_adapter_version_mismatch") {
      return unavailable(result.data.error.message);
    }
    return {
      ok: false,
      kind: "invalid",
      error: {
        code: "invalid_configuration",
        message: result.data.error.message,
        ...(result.data.error.path === undefined
          ? { path: ["config"] }
          : { path: ["config", ...result.data.error.path] }),
      },
    };
  } catch {
    return unavailable(
      "无法连接当前运行器验证长期配置；请确认运行器在线后重试。",
    );
  }
}

function unavailable(message: string): RuntimeConfigurationValidation {
  return {
    ok: false,
    kind: "unavailable",
    error: {
      code: "runtime_configuration_validation_unavailable",
      message,
      path: ["config"],
    },
  };
}
