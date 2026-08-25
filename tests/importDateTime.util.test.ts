import {
  formatImportDateTimeForDisplay,
  importPickRaw,
  isImportDateTimePresent,
  parseImportDateTime,
} from "../src/shared/utils/importDateTime";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

describe("importDateTime utilities", () => {
  it("returns null for empty values", () => {
    expect(parseImportDateTime(null, KOLKATA)).toBeNull();
    expect(parseImportDateTime(undefined, KOLKATA)).toBeNull();
    expect(parseImportDateTime("", KOLKATA)).toBeNull();
    expect(parseImportDateTime("   ", KOLKATA)).toBeNull();
    expect(isImportDateTimePresent("")).toBe(false);
  });

  it("parses wall-clock DD/MM/YYYY HH:mm in Asia/Kolkata as UTC", () => {
    const d = parseImportDateTime("25/05/2026 22:15", KOLKATA);
    expect(d?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
  });

  it("parses same wall-clock differently per timezone", () => {
    const ist = parseImportDateTime("25/05/2026 22:15", KOLKATA);
    const ny = parseImportDateTime("25/05/2026 22:15", NEW_YORK);
    expect(ist?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
    expect(ny?.toISOString()).toBe("2026-05-26T02:15:00.000Z");
    expect(ist?.toISOString()).not.toBe(ny?.toISOString());
  });

  it("parses DD/MM/YY HH:mm in user timezone", () => {
    const d = parseImportDateTime("25/05/26 22:15", KOLKATA);
    expect(d?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
  });

  it("parses DD/MM/YYYY HH:mm:ss with seconds", () => {
    const d = parseImportDateTime("25/05/2026 22:15:00", KOLKATA);
    expect(d?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
  });

  it("parses DD/MM/YYYY with AM/PM in user timezone", () => {
    const d = parseImportDateTime("25/05/2026 10:15:00 PM", KOLKATA);
    expect(d?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
  });

  it("parses YYYY-MM-DD HH:mm in user timezone", () => {
    const d = parseImportDateTime("2026-05-25 22:15", KOLKATA);
    expect(d?.toISOString()).toBe("2026-05-25T16:45:00.000Z");
  });

  it("keeps ISO strings with Z as absolute instants", () => {
    const iso = "2026-05-25T16:45:00.000Z";
    expect(parseImportDateTime(iso, KOLKATA)?.toISOString()).toBe(iso);
    expect(parseImportDateTime(iso, NEW_YORK)?.toISOString()).toBe(iso);
  });

  it("parses Excel serial numbers in user timezone", () => {
    const d = parseImportDateTime(45772.925, KOLKATA);
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBeGreaterThanOrEqual(2025);
  });

  it("accepts Date instances as absolute instants", () => {
    const input = new Date("2026-05-25T16:45:00.000Z");
    const d = parseImportDateTime(input, KOLKATA);
    expect(d?.toISOString()).toBe(input.toISOString());
  });

  it("importPickRaw preserves Date and number types", () => {
    const date = new Date("2026-05-25T16:45:00.000Z");
    const row = { "Date Time": date, Amount: 100 };
    expect(importPickRaw(row, "date time")).toBe(date);

    const serialRow = { datetime: 45772.925 };
    expect(importPickRaw(serialRow, "datetime")).toBe(45772.925);
  });

  it("formatImportDateTimeForDisplay stringifies values for error export", () => {
    const date = new Date("2026-05-25T16:45:00.000Z");
    expect(formatImportDateTimeForDisplay(date)).toBe("2026-05-25T16:45:00.000Z");
    expect(formatImportDateTimeForDisplay("25/05/26 22:15")).toBe("25/05/26 22:15");
  });
});
