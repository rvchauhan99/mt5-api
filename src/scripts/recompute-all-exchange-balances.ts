import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../shared/db/connect";
import { logger } from "../shared/logger";
import {
  planAllExchangeCurrentBalanceSync,
  syncAllExchangeCurrentBalances,
} from "../shared/services/exchange-balance.service";

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyChanged = args.includes("--only-changed");
  return { apply, onlyChanged };
}

async function main() {
  const { apply, onlyChanged } = parseArgs();
  await connectDb();

  if (apply) {
    const result = await syncAllExchangeCurrentBalances({ apply: true });
    logger.info(
      {
        mode: "apply",
        totalExchanges: result.total,
        changedExchanges: result.updated,
        unchangedExchanges: result.unchanged,
      },
      "exchange balance reconciliation summary",
    );
    logger.info(
      { updatedCount: result.updated, unchanged: result.unchanged },
      "exchange currentBalance sync complete",
    );
  } else {
    const plan = await planAllExchangeCurrentBalanceSync();
    const rowsToShow = onlyChanged ? plan.filter((row) => row.changed) : plan;

    logger.info(
      {
        mode: "dry-run",
        totalExchanges: plan.length,
        changedExchanges: plan.filter((row) => row.changed).length,
        unchangedExchanges: plan.filter((row) => !row.changed).length,
      },
      "exchange balance reconciliation summary",
    );

    for (const row of rowsToShow) {
      logger.info(
        {
          exchangeId: row.exchangeId,
          name: row.name,
          provider: row.provider,
          previousCurrentBalance: row.previousCurrentBalance,
          computedCurrentBalance: row.computedCurrentBalance,
          delta: row.delta,
        },
        "exchange balance reconciliation row",
      );
    }
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  logger.error({ error }, "exchange balance reconciliation failed");
  await mongoose.disconnect();
  process.exit(1);
});
