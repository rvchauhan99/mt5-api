/**
 * Runs once on deploy (server.ts → runMigrations).
 * Expect logs: "migration running" → "liability entry FX migration summary" → "migration applied".
 * Later deploys: "migration skipped (already applied)" for id 008_backfill_liability_entry_fx.
 *
 * Copies operatedCurrency / operatedAmount / exchangeRate from linked expense/deposit/withdrawal
 * onto liability entries that still store platform-default FX. Does not change ledger amount.
 */
import type { Db } from "mongodb";
import { logger } from "../shared/logger";
import { runBackfillLiabilityEntryFx } from "../shared/services/liability-entry-fx-backfill.service";

const ENTRY_COLLECTIONS = ["liabilityentries"] as const;

export const migration008BackfillLiabilityEntryFx = {
  id: "008_backfill_liability_entry_fx" as const,

  async up(db: Db): Promise<void> {
    const existingCollections = new Set((await db.listCollections().toArray()).map((c) => c.name));
    const entryCollection = ENTRY_COLLECTIONS.find((name) => existingCollections.has(name));

    if (!entryCollection) {
      logger.info(
        {
          migrationId: migration008BackfillLiabilityEntryFx.id,
          checkedCollections: [...ENTRY_COLLECTIONS],
        },
        "liability entry collection not found; skipping migration",
      );
      return;
    }

    const result = await runBackfillLiabilityEntryFx({ dryRun: false });

    logger.info(
      {
        migrationId: migration008BackfillLiabilityEntryFx.id,
        scanned: result.scanned,
        planned: result.planned,
        modified: result.modified,
        bySource: result.bySource,
        elapsedMs: result.elapsedMs,
      },
      "liability entry FX migration summary",
    );
  },
};
