/**
 * Runs once on deploy (server.ts → runMigrations).
 * Expect logs: "migration running" → "exchange currentBalance migration summary" → "migration applied".
 * Later deploys: "migration skipped (already applied)" for id 005_recompute_exchange_current_balances.
 */
import type { Db } from "mongodb";
import { logger } from "../shared/logger";
import { syncAllExchangeCurrentBalances } from "../shared/services/exchange-balance.service";

const EXCHANGES_COLLECTION = "exchanges";

export const migration005RecomputeExchangeCurrentBalances = {
  id: "005_recompute_exchange_current_balances" as const,

  async up(db: Db): Promise<void> {
    const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));

    if (!existingCollections.has(EXCHANGES_COLLECTION)) {
      logger.info(
        { migrationId: migration005RecomputeExchangeCurrentBalances.id },
        "exchanges collection not found; skipping migration",
      );
      return;
    }

    const result = await syncAllExchangeCurrentBalances({ apply: true });

    logger.info(
      {
        migrationId: migration005RecomputeExchangeCurrentBalances.id,
        total: result.total,
        updated: result.updated,
        unchanged: result.unchanged,
      },
      "exchange currentBalance migration summary",
    );
  },
};
