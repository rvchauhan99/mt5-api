import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../shared/db/connect";
import { logger } from "../shared/logger";
import { runBackfillLiabilityEntryFx } from "../shared/services/liability-entry-fx-backfill.service";

function parseArgs(): { dryRun: boolean } {
  const args = new Set(process.argv.slice(2));
  return { dryRun: !args.has("--apply") };
}

export async function main() {
  const options = parseArgs();
  await connectDb();
  const summary = await runBackfillLiabilityEntryFx(options);
  logger.info(summary, "backfill liability entry FX completed");
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error({ error }, "backfill liability entry FX failed");
    await mongoose.disconnect();
    process.exit(1);
  });
}
