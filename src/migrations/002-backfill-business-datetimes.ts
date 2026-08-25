import type { Db } from "mongodb";
import { logger } from "../shared/logger";

function missingOrNull(fieldName: "entryAt" | "requestedAt") {
  return {
    $or: [{ [fieldName]: { $exists: false } }, { [fieldName]: null }],
  };
}

export const migration002BackfillBusinessDatetimes = {
  id: "002_backfill_business_datetimes" as const,

  async up(db: Db): Promise<void> {
    const depositsFilter = missingOrNull("entryAt");
    const withdrawalsFilter = missingOrNull("requestedAt");

    const [depositMatched, withdrawalMatched] = await Promise.all([
      db.collection("deposits").countDocuments(depositsFilter),
      db.collection("withdrawals").countDocuments(withdrawalsFilter),
    ]);

    const [depositResult, withdrawalResult] = await Promise.all([
      db.collection("deposits").updateMany(depositsFilter, [{ $set: { entryAt: "$createdAt" } }]),
      db.collection("withdrawals").updateMany(withdrawalsFilter, [{ $set: { requestedAt: "$createdAt" } }]),
    ]);

    logger.info(
      {
        migrationId: "002_backfill_business_datetimes",
        deposits: { matched: depositMatched, modified: depositResult.modifiedCount ?? 0 },
        withdrawals: { matched: withdrawalMatched, modified: withdrawalResult.modifiedCount ?? 0 },
      },
      "backfill business datetime migration summary",
    );
  },
};
