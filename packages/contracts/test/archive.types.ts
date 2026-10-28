import type {
  ArchiveCommit,
  ArchiveItemInput,
  ArchiveSubmissionInput,
} from "../src/archive.ts";

const item: ArchiveItemInput = {
  sourceKey: { namespace: "rss.example", key: "entry/7" },
  body: { text: "正文" },
  capture: {
    scope: { feed: "main" },
    completeness: "complete",
    missing: [],
  },
};

const submission: ArchiveSubmissionInput = {
  requestId: "rss:request-7",
  binId: "rss-main",
  items: [item],
};

// @ts-expect-error 信源身份必须同时提供命名空间和稳定对象键。
const missingObjectKey: ArchiveItemInput["sourceKey"] = {
  namespace: "rss.example",
};

// @ts-expect-error JSON 请求标识必须是字符串。
const invalidRequestId: ArchiveSubmissionInput["requestId"] = 17;

// @ts-expect-error PostgreSQL BIGINT 序号在线上使用十进制字符串。
const invalidArchiveSequence: ArchiveCommit["archiveSeq"] = 17;

void [submission, missingObjectKey, invalidRequestId, invalidArchiveSequence];
