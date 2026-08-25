export const DEFAULT_TIMEZONE = "Asia/Kolkata";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function toZonedParts(date: Date, timeZone: string): ZonedDateParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const out: Partial<ZonedDateParts> = {};
  for (const part of parts) {
    if (part.type === "year") out.year = Number(part.value);
    if (part.type === "month") out.month = Number(part.value);
    if (part.type === "day") out.day = Number(part.value);
    if (part.type === "hour") out.hour = Number(part.value);
    if (part.type === "minute") out.minute = Number(part.value);
    if (part.type === "second") out.second = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = toZonedParts(date, timeZone);
  const zonedAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return (zonedAsUtcMs - date.getTime()) / 60000;
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): Date {
  const targetWallMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guessMs = targetWallMs;
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(guessMs), timeZone);
    const adjusted = targetWallMs - offsetMinutes * 60 * 1000;
    if (adjusted === guessMs) break;
    guessMs = adjusted;
  }
  return new Date(guessMs);
}

/** Wall-clock components in an IANA timezone → UTC instant (for import / business entry). */
export function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  return zonedDateTimeToUtc(year, month, day, hour, minute, second, 0, normalizeTimeZone(timeZone));
}

export function isValidIanaTimeZone(timeZone: string | undefined | null): boolean {
  if (!timeZone || !String(timeZone).trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(timeZone).trim() });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(
  timeZone: string | undefined | null,
  fallback: string = DEFAULT_TIMEZONE,
): string {
  const normalizedFallback = isValidIanaTimeZone(fallback) ? fallback : DEFAULT_TIMEZONE;
  if (!isValidIanaTimeZone(timeZone)) return normalizedFallback;
  return String(timeZone).trim();
}

export function extractTimezoneHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return extractTimezoneHeader(value[0]);
  }
  if (typeof value !== "string") return undefined;
  const first = value.split(",")[0]?.trim();
  return first || undefined;
}

export function resolveEffectiveTimeZone(input: {
  userTimeZone?: string;
  headerTimeZone?: string;
  fallbackTimeZone?: string;
}): string {
  if (isValidIanaTimeZone(input.userTimeZone)) return String(input.userTimeZone).trim();
  if (isValidIanaTimeZone(input.headerTimeZone)) return String(input.headerTimeZone).trim();
  return normalizeTimeZone(input.fallbackTimeZone, DEFAULT_TIMEZONE);
}

export function ymdToUtcStart(ymd: string, timeZone: string): Date | null {
  if (!YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedDateTimeToUtc(y, m, d, 0, 0, 0, 0, normalizeTimeZone(timeZone));
}

export function ymdToUtcEnd(ymd: string, timeZone: string): Date | null {
  if (!YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const nextUtcDay = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) + 24 * 60 * 60 * 1000);
  const nextYear = nextUtcDay.getUTCFullYear();
  const nextMonth = nextUtcDay.getUTCMonth() + 1;
  const nextDay = nextUtcDay.getUTCDate();
  const nextDayStartUtc = zonedDateTimeToUtc(nextYear, nextMonth, nextDay, 0, 0, 0, 0, normalizeTimeZone(timeZone));
  return new Date(nextDayStartUtc.getTime() - 1);
}

export function ymdToUtcNoon(ymd: string, timeZone: string): Date | null {
  if (!YMD_RE.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedDateTimeToUtc(y, m, d, 12, 0, 0, 0, normalizeTimeZone(timeZone));
}

export function formatDateForTimeZone(
  value: Date | string | number | undefined | null,
  timeZone: string,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
}

export function formatDateTimeForTimeZone(
  value: Date | string | number | undefined | null,
  timeZone: string,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const second = parts.find((p) => p.type === "second")?.value ?? "";
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
