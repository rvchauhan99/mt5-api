import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  formatDateTimeForTimeZone,
  normalizeTimeZone,
  resolveEffectiveTimeZone,
  ymdToUtcEnd,
  ymdToUtcStart,
} from "../src/shared/utils/timezone";

describe("shared timezone utilities", () => {
  it("converts Asia/Kolkata day bounds to UTC", () => {
    const start = ymdToUtcStart("2026-04-17", "Asia/Kolkata");
    const end = ymdToUtcEnd("2026-04-17", "Asia/Kolkata");
    expect(start?.toISOString()).toBe("2026-04-16T18:30:00.000Z");
    expect(end?.toISOString()).toBe("2026-04-17T18:29:59.999Z");
  });

  it("formats UTC values in requested timezone", () => {
    const utc = "2026-04-17T18:30:00.000Z";
    expect(formatDateForTimeZone(utc, "Asia/Kolkata")).toBe("2026-04-18");
    expect(formatDateTimeForTimeZone(utc, "Asia/Kolkata")).toContain("2026-04-18");
  });

  it("resolves effective timezone by user->header->fallback order", () => {
    expect(
      resolveEffectiveTimeZone({
        userTimeZone: "Asia/Kolkata",
        headerTimeZone: "America/New_York",
      }),
    ).toBe("Asia/Kolkata");
    expect(
      resolveEffectiveTimeZone({
        userTimeZone: "",
        headerTimeZone: "America/New_York",
      }),
    ).toBe("America/New_York");
    expect(
      resolveEffectiveTimeZone({
        userTimeZone: "bad-zone",
        headerTimeZone: "also-bad",
      }),
    ).toBe(DEFAULT_TIMEZONE);
  });

  it("normalizes invalid timezone to default", () => {
    expect(normalizeTimeZone("Invalid/Zone")).toBe(DEFAULT_TIMEZONE);
  });
});
