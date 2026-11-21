# Root package.json is passed via `--file package.json` and binds these variables.
variable "engines" {
  default = {}
}

variable "packageManager" {
  default = ""
}

variable "BINNY_IMAGE" {
  default = "binny/server:local"
}

variable "BINNY_TEST_LIGHTWEIGHT_IMAGE" {
  default = "binny/lightweight-fixture:local"
}

variable "BINNY_TEST_CONFIGURATION_IMAGE" {
  default = "binny/configuration-fixture:local"
}

variable "BINNY_TEST_RUNNER_IMAGE" {
  default = "binny/runner-fixture:local"
}

variable "BINNY_TEST_RUNNER_SCHEMA_IMAGE" {
  default = "binny/runner-schema-fixture:local"
}

variable "BINNY_TEST_LIGHTWEIGHT_RESOURCE_IMAGE" {
  default = "binny/lightweight-resource-fixture:local"
}

variable "BINNY_TEST_BROWSER_IMAGE" {
  default = "binny/source-adapter-browser-session-fixture:browser-v1"
}

variable "BINNY_TEST_VNC_VIEWER_IMAGE" {
  default = "binny/vnc-viewer-fixture:local"
}

variable "BINNY_RSS_IMAGE" {
  default = "binny/rss:local"
}

variable "BINNY_ARTICLE_OPENAI_IMAGE" {
  default = "binny/openai:local"
}

variable "BINNY_ARTICLE_ANTHROPIC_IMAGE" {
  default = "binny/anthropic:local"
}

variable "BINNY_ARTICLE_GOOGLE_IMAGE" {
  default = "binny/google:local"
}

variable "BINNY_ARTICLE_HUGGINGFACE_IMAGE" {
  default = "binny/huggingface:local"
}

variable "BINNY_ARTICLE_MISTRAL_IMAGE" {
  default = "binny/mistral:local"
}

variable "BINNY_DOCUMENT_DEEPSEEK_IMAGE" {
  default = "binny/deepseek:local"
}

variable "BINNY_DOCUMENT_QWEN_IMAGE" {
  default = "binny/qwen:local"
}

variable "BINNY_DOCUMENT_KIMI_IMAGE" {
  default = "binny/kimi:local"
}

variable "BINNY_DOCUMENT_MINIMAX_IMAGE" {
  default = "binny/minimax:local"
}

variable "BINNY_DOCUMENT_QODER_IMAGE" {
  default = "binny/qoder:local"
}

variable "BINNY_LINUXDO_IMAGE" {
  default = "binny/linuxdo:local"
}

function "node_version" {
  params = []
  result = engines.node
}

function "pnpm_version" {
  params = []
  result = split("+", trimprefix(packageManager, "pnpm@"))[0]
}

group "default" {
  targets = [
    "server",
    "runtime-lightweight",
    "runtime-browser",
    "runtime-protocol-fixture",
    "runtime-configuration-fixture",
    "runtime-manual-runs-fixture",
    "runtime-schema-fixture",
    "runtime-vnc-viewer-fixture",
    "adapter-lightweight-resource-fixture",
    "adapter-browser-session-fixture",
    "adapter-rss",
    "adapter-openai",
    "adapter-anthropic",
    "adapter-google",
    "adapter-huggingface",
    "adapter-mistral",
    "adapter-deepseek",
    "adapter-qwen",
    "adapter-kimi",
    "adapter-minimax",
    "adapter-qoder",
    "adapter-linuxdo",
  ]
}

target "_common" {
  context = "."
  contexts = {
    node-bookworm-slim = "docker-image://node:${node_version()}-bookworm-slim"
    pnpm-release       = "docker-image://ghcr.io/pnpm/pnpm:${pnpm_version()}"
  }
}

target "server" {
  inherits   = ["_common"]
  dockerfile = "Dockerfile"
  tags       = [BINNY_IMAGE]
}

target "runtime-lightweight" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.lightweight"
  tags       = ["binny/source-adapter-runtime:lightweight-v1"]
}

target "runtime-browser" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.browser"
  platforms  = ["linux/amd64"]
  tags       = ["binny/source-adapter-runtime:browser-v1"]
}

target "runtime-protocol-fixture" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.protocol-fixture"
  tags       = [BINNY_TEST_LIGHTWEIGHT_IMAGE]
}

target "runtime-configuration-fixture" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.configuration-fixture"
  tags       = [BINNY_TEST_CONFIGURATION_IMAGE]
}

target "runtime-manual-runs-fixture" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.manual-runs-fixture"
  tags       = [BINNY_TEST_RUNNER_IMAGE]
}

target "runtime-schema-fixture" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.schema-fixture"
  tags       = [BINNY_TEST_RUNNER_SCHEMA_IMAGE]
}

target "runtime-vnc-viewer-fixture" {
  inherits   = ["_common"]
  dockerfile = "packages/source-adapter-runtime/Dockerfile.vnc-viewer-fixture"
  tags       = [BINNY_TEST_VNC_VIEWER_IMAGE]
}

target "adapter-lightweight-resource-fixture" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/lightweight-resource-fixture/Dockerfile"
  tags       = [BINNY_TEST_LIGHTWEIGHT_RESOURCE_IMAGE]
}

target "adapter-browser-session-fixture" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/browser-session-fixture/Dockerfile"
  platforms  = ["linux/amd64"]
  tags       = [BINNY_TEST_BROWSER_IMAGE]
}

target "adapter-rss" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/rss/Dockerfile"
  tags       = [BINNY_RSS_IMAGE]
}

target "adapter-openai" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/openai/Dockerfile"
  tags       = [BINNY_ARTICLE_OPENAI_IMAGE]
}

target "adapter-anthropic" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/anthropic/Dockerfile"
  tags       = [BINNY_ARTICLE_ANTHROPIC_IMAGE]
}

target "adapter-google" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/google/Dockerfile"
  tags       = [BINNY_ARTICLE_GOOGLE_IMAGE]
}

target "adapter-huggingface" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/huggingface/Dockerfile"
  tags       = [BINNY_ARTICLE_HUGGINGFACE_IMAGE]
}

target "adapter-mistral" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/mistral/Dockerfile"
  tags       = [BINNY_ARTICLE_MISTRAL_IMAGE]
}

target "adapter-deepseek" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/deepseek/Dockerfile"
  tags       = [BINNY_DOCUMENT_DEEPSEEK_IMAGE]
}

target "adapter-qwen" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/qwen/Dockerfile"
  tags       = [BINNY_DOCUMENT_QWEN_IMAGE]
}

target "adapter-kimi" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/kimi/Dockerfile"
  tags       = [BINNY_DOCUMENT_KIMI_IMAGE]
}

target "adapter-minimax" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/minimax/Dockerfile"
  tags       = [BINNY_DOCUMENT_MINIMAX_IMAGE]
}

target "adapter-qoder" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/qoder/Dockerfile"
  tags       = [BINNY_DOCUMENT_QODER_IMAGE]
}

target "adapter-linuxdo" {
  inherits   = ["_common"]
  dockerfile = "source-adapters/linuxdo/Dockerfile"
  platforms  = ["linux/amd64"]
  tags       = [BINNY_LINUXDO_IMAGE]
}
