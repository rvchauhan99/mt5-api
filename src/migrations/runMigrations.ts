import mongoose from "mongoose";
import type { Db } from "mongodb";
import { logger } from "../shared/logger";
import { migration001DropNotificationCollections } from "./001-drop-notification-collections";
import { migration002BackfillBusinessDatetimes } from "./002-backfill-business-datetimes";
import { migration003LiabilityPersonSideClosingBalance } from "./003-liability-person-side-closing-balance";
import { migration004SeedExpenseCancelReasons } from "./004-seed-expense-cancel-reasons";
import { migration005RecomputeExchangeCurrentBalances } from "./005-recompute-exchange-current-balances";

export const MIGRATIONS_COLLECTION = "__migrations";

export type Migration = {
  id: string;
  up: (db: Db) => Promise<void>;
};

const registry: Migration[] = [
  migration001DropNotificationCollections,
  migration002BackfillBusinessDatetimes,
  migration003LiabilityPersonSideClosingBalance,
  migration004SeedExpenseCancelReasons,
  migration005RecomputeExchangeCurrentBalances,
];

export async function runMigrations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("MongoDB connection not ready");
  }

  const coll = db.collection(MIGRATIONS_COLLECTION);
  await coll.createIndex({ migrationId: 1 }, { unique: true });

  for (const migration of registry) {
    const applied = await coll.findOne({ migrationId: migration.id });
    if (applied) {
      logger.info({ migrationId: migration.id }, "migration skipped (already applied)");
      continue;
    }

    try {
      logger.info({ migrationId: migration.id }, "migration running");
      await migration.up(db);
      await coll.insertOne({ migrationId: migration.id, appliedAt: new Date() });
      logger.info({ migrationId: migration.id }, "migration applied");
    } catch (err) {
      logger.error({ err, migrationId: migration.id }, "migration failed");
      process.exit(1);
    }
  }
}
