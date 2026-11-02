import { readFileSync } from "node:fs";

const NativeDate = Date;
const offsetFile = process.env.BINNY_TEST_CLOCK_FILE;

function now(): number {
  if (offsetFile === undefined) return NativeDate.now();

  let offsetText: string;
  try {
    offsetText = readFileSync(offsetFile, "utf8").trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return NativeDate.now();
    }
    throw error;
  }
  if (offsetText === "") return NativeDate.now();

  const offset = Number(offsetText);
  if (!Number.isFinite(offset)) {
    throw new Error("测试时钟偏移不是有限数字。");
  }
  return NativeDate.now() + offset;
}

globalThis.Date = new Proxy(NativeDate, {
  apply() {
    return new NativeDate(now()).toString();
  },
  construct(target, args, newTarget) {
    return Reflect.construct(
      target,
      args.length === 0 ? [now()] : args,
      newTarget,
    );
  },
  get(target, property, receiver) {
    if (property === "now") return now;
    return Reflect.get(target, property, receiver);
  },
});
