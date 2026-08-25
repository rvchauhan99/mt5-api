/** Rules mirrored from validateDepositImportRows player/bonus logic (unit-level, no DB). */

function computeImportTotalAmount(
  amount: number,
  playerMongoId: string | undefined,
  bonusAmount: number | undefined,
): number | undefined {
  if (playerMongoId == null || bonusAmount == null) return undefined;
  return Math.round(amount + bonusAmount);
}

describe("deposit import player/bonus rules", () => {
  it("computes totalAmount as amount + bonus", () => {
    expect(computeImportTotalAmount(5000, "mongo-id", 500)).toBe(5500);
  });

  it("returns undefined total when no player", () => {
    expect(computeImportTotalAmount(5000, undefined, undefined)).toBeUndefined();
  });

  it("uses zero bonus when only player is set", () => {
    expect(computeImportTotalAmount(5000, "mongo-id", 0)).toBe(5000);
  });
});
