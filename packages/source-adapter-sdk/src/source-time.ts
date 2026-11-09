import { sourceTimeSchema, type SourceTime } from "@binny/contracts";

const precisions = ["instant", "day", "month", "year"] as const;

const monthNumbers: Readonly<Record<string, string>> = {
  apr: "04",
  april: "04",
  aug: "08",
  august: "08",
  dec: "12",
  december: "12",
  feb: "02",
  february: "02",
  jan: "01",
  january: "01",
  jul: "07",
  july: "07",
  jun: "06",
  june: "06",
  mar: "03",
  march: "03",
  may: "05",
  nov: "11",
  november: "11",
  oct: "10",
  october: "10",
  sep: "09",
  sept: "09",
  september: "09",
};

function validatedSourceTime(
  precision: SourceTime["precision"],
  value: string,
  timeZone?: string,
): SourceTime | null {
  const parsed = sourceTimeSchema.safeParse({
    precision,
    value,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return parsed.success ? parsed.data : null;
}

function parseRfcDate(value: string): SourceTime | null {
  const match =
    /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|([+-])(\d{2}):?(\d{2}))$/iu.exec(
      value,
    );
  if (!match) return null;

  const day = match[1]?.padStart(2, "0");
  const month = monthNumbers[(match[2] ?? "").toLowerCase()];
  const year = match[3];
  const hour = match[4];
  const minute = match[5];
  const second = match[6] ?? "00";
  const zone = match[7];
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    zone === undefined
  ) {
    return null;
  }

  if (zone.toUpperCase() === "GMT" || zone.toUpperCase() === "UTC") {
    return validatedSourceTime(
      "instant",
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
      "UTC",
    );
  }

  const sign = match[8];
  const offsetHours = match[9];
  const offsetMinutes = match[10];
  if (
    sign === undefined ||
    offsetHours === undefined ||
    offsetMinutes === undefined
  ) {
    return null;
  }
  return validatedSourceTime(
    "instant",
    `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetMinutes}`,
  );
}

function parseCalendarDate(value: string): SourceTime | null {
  const dayMatch = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/u.exec(value);
  if (dayMatch) {
    const month = monthNumbers[(dayMatch[1] ?? "").toLowerCase()];
    const day = dayMatch[2]?.padStart(2, "0");
    const year = dayMatch[3];
    if (month !== undefined && day !== undefined && year !== undefined) {
      return validatedSourceTime("day", `${year}-${month}-${day}`);
    }
  }

  const monthMatch = /^([A-Za-z]+)\s+(\d{4})$/u.exec(value);
  if (monthMatch) {
    const month = monthNumbers[(monthMatch[1] ?? "").toLowerCase()];
    const year = monthMatch[2];
    if (month !== undefined && year !== undefined) {
      return validatedSourceTime("month", `${year}-${month}`);
    }
  }
  return null;
}

/**
 * Parses source supplied dates without filling missing precision or timezone.
 * ISO SourceTime values and explicit RFC dates are validated by the archive
 * contract; unsupported or invalid date strings produce `null`.
 */
export function sourceTimeFrom(value?: string | null): SourceTime | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  for (const precision of precisions) {
    const parsed = validatedSourceTime(precision, trimmed);
    if (parsed !== null) return parsed;
  }

  const compactOffset =
    /^(.*[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})(\d{2})$/u.exec(
      trimmed,
    );
  if (compactOffset) {
    const normalized = `${compactOffset[1]}${compactOffset[2]}:${compactOffset[3]}`;
    const parsed = validatedSourceTime("instant", normalized);
    if (parsed !== null) return parsed;
  }

  return parseRfcDate(trimmed) ?? parseCalendarDate(trimmed);
}
