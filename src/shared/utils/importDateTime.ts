import xlsx from "xlsx";
import { normalizeTimeZone, wallClockToUtc } from "./timezone";

function normalizeHeaderKey(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function expandTwoDigitYear(yy: string): string {
  if (yy.length === 4) return yy;
  const num = parseInt(yy, 10);
  return String(num < 70 ? 2000 + num : 1900 + num);
}

function apply12Hour(hour: number, ampm?: string): number {
  if (!ampm) return hour;
  const upper = ampm.toUpperCase();
  if (upper === "PM" && hour < 12) return hour + 12;
  if (upper === "AM" && hour === 12) return 0;
  return hour;
}

function hasAbsoluteTimezone(trimmed: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) || /[T\s]\d{2}:\d{2}.*[+-]\d/.test(trimmed);
}

function parseExcelSerialInTimeZone(serial: number, timeZone: string): Date | null {
  if (serial <= 1000 || serial >= 100000) return null;
  const parts = xlsx.SSF.parse_date_code(serial);
  if (!parts || parts.y == null || parts.m == null || parts.d == null) return null;
  return wallClockToUtc(
    parts.y,
    parts.m,
    parts.d,
    parts.H ?? 0,
    parts.M ?? 0,
    parts.S ?? 0,
    timeZone,
  );
}

function parseWallClockDateTimeString(trimmed: string, timeZone: string): Date | null {
  if (/^\d{4,5}(\.\d+)?$/.test(trimmed) && !trimmed.includes("/") && !trimmed.includes("-")) {
    const serial = parseFloat(trimmed);
    return parseExcelSerialInTimeZone(serial, timeZone);
  }

  if (hasAbsoluteTimezone(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const ddmmMatch = trimmed.match(
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i,
  );
  if (ddmmMatch) {
    const [, dd, mm, yyOrYyyy, hh, min, sec, ampm] = ddmmMatch;
    const yyyy = Number(expandTwoDigitYear(yyOrYyyy!));
    const hour = apply12Hour(parseInt(hh ?? "0", 10), ampm);
    return wallClockToUtc(
      yyyy,
      Number(mm),
      Number(dd),
      hour,
      parseInt(min ?? "0", 10),
      parseInt(sec ?? "0", 10),
      timeZone,
    );
  }

  const isoMatch = trimmed.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i,
  );
  if (isoMatch) {
    const [, yyyy, mm, dd, hh, min, sec, ampm] = isoMatch;
    const hour = apply12Hour(parseInt(hh ?? "0", 10), ampm);
    return wallClockToUtc(
      Number(yyyy),
      Number(mm),
      Number(dd),
      hour,
      parseInt(min ?? "0", 10),
      parseInt(sec ?? "0", 10),
      timeZone,
    );
  }

  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** First matching non-empty cell value without string coercion (preserves Date/number from Excel). */
export function importPickRaw(row: Record<string, unknown>, ...aliases: string[]): unknown {
  const wanted = new Set(aliases.map((a) => normalizeHeaderKey(a)));
  for (const [key, val] of Object.entries(row)) {
    if (!wanted.has(normalizeHeaderKey(key))) continue;
    if (val == null) continue;
    if (val instanceof Date) {
      if (!Number.isNaN(val.getTime())) return val;
      continue;
    }
    if (typeof val === "number" && !Number.isNaN(val)) return val;
    if (String(val).trim() !== "") return val;
  }
  return undefined;
}

export function isImportDateTimePresent(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "number") return !Number.isNaN(value);
  return String(value).trim() !== "";
}

export function formatImportDateTimeForDisplay(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return String(value).trim();
}

export function parseImportDateTime(value: unknown, timeZone: string): Date | null {
  const tz = normalizeTimeZone(timeZone);
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    return parseExcelSerialInTimeZone(value, tz);
  }
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return parseWallClockDateTimeString(trimmed, tz);
}
