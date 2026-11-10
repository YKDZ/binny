#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { cliCommandIdentity } from "./cli-command-identity.ts";
import { runCli } from "./main.ts";

const require = createRequire(import.meta.url);
process.exitCode = await runCli({
  argv: process.argv,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  },
  ...(process.env.BINNY_API_URL === undefined
    ? {}
    : { apiUrl: process.env.BINNY_API_URL }),
  // 身份读取和校验也使用 runCli 的意外故障出口。
  get identity() {
    return cliCommandIdentity(require("../package.json"));
  },
});
