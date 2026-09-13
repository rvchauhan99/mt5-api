import { balanceSheetMath } from "../src/modules/balance-sheet/balance-sheet.service";

describe("balance sheet math helpers", () => {
  it("rounds to 2 decimal places", () => {
    expect(balanceSheetMath.round2(1.005)).toBe(1.01);
    expect(balanceSheetMath.round2(10.1)).toBe(10.1);
    expect(balanceSheetMath.round2(0)).toBe(0);
  });

  it("returns null compare range for none", () => {
    expect(
      balanceSheetMath.resolveCompareRange("2026-01-01", "2026-01-31", "none", "Asia/Kolkata"),
    ).toBeNull();
  });

  it("resolves prior_period compare window", () => {
    const range = balanceSheetMath.resolveCompareRange(
      "2026-02-01",
      "2026-02-28",
      "prior_period",
      "Asia/Kolkata",
    );
    expect(range).not.toBeNull();
    expect(range!.compareToDate).toBe("2026-01-31");
    expect(range!.compareFromDate).toBe("2026-01-04");
  });

  it("resolves yoy by shifting year", () => {
    const range = balanceSheetMath.resolveCompareRange(
      "2026-04-01",
      "2026-04-30",
      "yoy",
      "Asia/Kolkata",
    );
    expect(range).toEqual({
      compareFromDate: "2025-04-01",
      compareToDate: "2025-04-30",
    });
  });

  it("resolves qoq by shifting three months", () => {
    const range = balanceSheetMath.resolveCompareRange(
      "2026-04-01",
      "2026-06-30",
      "qoq",
      "Asia/Kolkata",
    );
    expect(range).not.toBeNull();
    expect(range!.compareFromDate).toBe("2026-01-01");
    expect(range!.compareToDate).toBe("2026-03-30");
  });

  it("exposes balance tolerance of 0.01", () => {
    expect(balanceSheetMath.BALANCE_TOLERANCE).toBe(0.01);
  });
});

describe("balance sheet accounting identity helpers", () => {
  it("treats assets minus liabilities+equity as balanced within tolerance", () => {
    const totalAssets = 1000.0;
    const totalLiabilities = 400.0;
    const totalEquity = 600.0;
    const difference = balanceSheetMath.round2(totalAssets - (totalLiabilities + totalEquity));
    expect(Math.abs(difference) <= balanceSheetMath.BALANCE_TOLERANCE).toBe(true);
  });

  it("flags unbalanced sheets beyond tolerance", () => {
    const totalAssets = 1000.0;
    const totalLiabilities = 400.0;
    const totalEquity = 599.0;
    const difference = balanceSheetMath.round2(totalAssets - (totalLiabilities + totalEquity));
    expect(Math.abs(difference) <= balanceSheetMath.BALANCE_TOLERANCE).toBe(false);
  });
});
