import "dotenv/config";
import mongoose, { type Model } from "mongoose";
import { connectDb } from "../shared/db/connect";
import { logger } from "../shared/logger";
import { DepositModel } from "../modules/deposit/deposit.model";
import { WithdrawalModel } from "../modules/withdrawal/withdrawal.model";

type BackfillOptions = {
  dryRun: boolean;
};

type BackfillSummary = {
  mode: "dry-run" | "apply";
  deposits: { matched: number; modified: number };
  withdrawals: { matched: number; modified: number };
  elapsedMs: number;
};

function parseArgs(): BackfillOptions {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  return { dryRun };
}

async function backfillCollection(
  model: Model<any>,
  fieldName: "entryAt" | "requestedAt",
  dryRun: boolean,
): Promise<{ matched: number; modified: number }> {
  const filter = {
    $or: [{ [fieldName]: { $exists: false } }, { [fieldName]: null }],
  };
  const matched = await model.countDocuments(filter);
  if (dryRun || matched === 0) {
    return { matched, modified: 0 };
  }

  const result = await model.updateMany(filter, [{ $set: { [fieldName]: "$createdAt" } }], {
    updatePipeline: true,
  });
  return { matched, modified: result.modifiedCount ?? 0 };
}

export async function runBackfillBusinessDatetimes(options: BackfillOptions): Promise<BackfillSummary> {
  const startedAt = Date.now();

  const [deposits, withdrawals] = await Promise.all([
    backfillCollection(DepositModel, "entryAt", options.dryRun),
    backfillCollection(WithdrawalModel, "requestedAt", options.dryRun),
  ]);

  return {
    mode: options.dryRun ? "dry-run" : "apply",
    deposits,
    withdrawals,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function main() {
  const options = parseArgs();
  await connectDb();
  const summary = await runBackfillBusinessDatetimes(options);

  logger.info(summary, "backfill business datetimes completed");
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error({ error }, "backfill business datetimes failed");
    await mongoose.disconnect();
    process.exit(1);
  });
}
