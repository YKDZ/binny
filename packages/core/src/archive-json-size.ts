// Count compact JSON bytes without allocating a body-sized string.
type JsonMeasurementFrame = {
  readonly value: unknown;
  kind?: "array" | "object";
  keys?: readonly string[];
  index: number;
  emitted: number;
};

function jsonStringByteLength(
  value: string,
  addBytes: (bytes: number) => boolean,
  assertActive: () => void,
): boolean {
  if (!addBytes(1)) return false;
  let checkedCodeUnits = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return false;
    const bytes =
      codePoint === 0x22 || codePoint === 0x5c
        ? 2
        : codePoint <= 0x1f
          ? codePoint === 0x08 ||
            codePoint === 0x09 ||
            codePoint === 0x0a ||
            codePoint === 0x0c ||
            codePoint === 0x0d
            ? 2
            : 6
          : codePoint <= 0x7f
            ? 1
            : codePoint <= 0x7ff
              ? 2
              : codePoint <= 0xffff
                ? 3
                : 4;
    if (!addBytes(bytes)) return false;
    checkedCodeUnits += character.length;
    if (checkedCodeUnits >= 65_536) {
      assertActive();
      checkedCodeUnits = 0;
    }
  }
  return addBytes(1);
}

/**
 * Measure compact JSON bytes for plain values parsed from validated archive JSONB
 * and the batch response assembled here. Optional fields are absent; JSON hooks
 * and arbitrary JavaScript objects are outside this contract.
 * Return undefined past the limit without allocating the complete JSON string.
 */
export function archiveJsonStringifyByteLength(
  value: unknown,
  maximumBytes: number,
  assertActive: () => void,
): number | undefined {
  let byteLength = 0;
  const addBytes = (bytes: number): boolean => {
    byteLength += bytes;
    return byteLength <= maximumBytes;
  };
  const stack: JsonMeasurementFrame[] = [{ value, index: 0, emitted: 0 }];

  while (stack.length > 0) {
    assertActive();
    const frame = stack[stack.length - 1];
    if (frame === undefined)
      throw new Error("JSON measurement stack is empty.");
    const current = frame.value;
    if (frame.kind === undefined) {
      if (current === null) {
        if (!addBytes(4)) return undefined;
        stack.pop();
      } else if (typeof current === "string") {
        if (!jsonStringByteLength(current, addBytes, assertActive)) {
          return undefined;
        }
        stack.pop();
      } else if (typeof current === "number") {
        const serialized = JSON.stringify(current);
        if (
          serialized === undefined ||
          !addBytes(Buffer.byteLength(serialized))
        ) {
          return undefined;
        }
        stack.pop();
      } else if (typeof current === "boolean") {
        if (!addBytes(current ? 4 : 5)) return undefined;
        stack.pop();
      } else if (Array.isArray(current)) {
        if (!addBytes(1)) return undefined;
        frame.kind = "array";
      } else if (typeof current === "object") {
        if (!addBytes(1)) return undefined;
        frame.kind = "object";
        frame.keys = Object.keys(current);
      } else {
        return undefined;
      }
      continue;
    }

    if (frame.kind === "array") {
      const items = current as readonly unknown[];
      if (frame.index >= items.length) {
        if (!addBytes(1)) return undefined;
        stack.pop();
        continue;
      }
      if (frame.index > 0 && !addBytes(1)) return undefined;
      const item = items[frame.index];
      frame.index += 1;
      stack.push({ value: item, index: 0, emitted: 0 });
      continue;
    }

    const record = current as Record<string, unknown>;
    const keys = frame.keys ?? [];
    if (frame.index >= keys.length) {
      if (!addBytes(1)) return undefined;
      stack.pop();
      continue;
    }
    const key = keys[frame.index];
    frame.index += 1;
    if (key === undefined) continue;
    const child = record[key];
    if (
      child === undefined ||
      typeof child === "function" ||
      typeof child === "symbol"
    ) {
      continue;
    }
    if (frame.emitted > 0 && !addBytes(1)) return undefined;
    if (!jsonStringByteLength(key, addBytes, assertActive) || !addBytes(1)) {
      return undefined;
    }
    frame.emitted += 1;
    stack.push({ value: child, index: 0, emitted: 0 });
  }

  return byteLength;
}
