/**
 * Clears the MongoDB configured by MONGO_URI in `.env` (via connectDb / dotenv).
 * Preserves `users` and `expense types`, drops every other collection, then
 * bootstraps permissions / superadmin / reasons.
 *
 * Also explicitly resets:
 * - Platform currency lock (PlatformSettings)
 * - Exchange Rate master (ExchangeRate)
 * - Exchange entities (Exchange)
 *
 * Refuses to run when NODE_ENV=production.
 *
 * Usage:
 *   npm run reset:database
 */
import "dotenv/config";
import mongoose from "mongoose";
import IORedis from "ioredis";
import { ExpenseTypeModel } from "../modules/masters/expense-type.model";
import { ExchangeRateModel } from "../modules/masters/exchange-rate.model";
import { ExchangeModel } from "../modules/exchange/exchange.model";
import { PlatformSettingsModel } from "../modules/settings/settings.model";
import { UserModel } from "../modules/users/user.model";
import { connectDb } from "../shared/db/connect";
import { bootstrapData } from "../shared/db/bootstrap";
import { logger } from "../shared/logger";

async function flushRedisIfConfigured(): Promise<void> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    logger.info("REDIS_URL not set; skipping Redis flush");
    return;
  }

  const redis = new IORedis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  try {
    await redis.flushdb();
    logger.info("Redis FLUSHDB completed for the database index in REDIS_URL");
  } finally {
    await redis.quit();
  }
}

/** Unlock platform currency and clear exchange rate master + exchange rows. */
async function resetPlatformCurrencyAndExchangeMaster(): Promise<void> {
  const [settingsResult, exchangeRateResult, exchangeResult] = await Promise.all([
    PlatformSettingsModel.deleteMany({}),
    ExchangeRateModel.deleteMany({}),
    ExchangeModel.deleteMany({}),
  ]);

  logger.info(
    {
      platformSettingsDeleted: settingsResult.deletedCount ?? 0,
      exchangeRatesDeleted: exchangeRateResult.deletedCount ?? 0,
      exchangesDeleted: exchangeResult.deletedCount ?? 0,
    },
    "Reset platform currency and exchange master (settings, exchange rates, exchanges)",
  );
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Database reset is refused when NODE_ENV=production");
  }

  await connectDb();
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("Database connection has no db handle");
  }

  const preserve = new Set([
    UserModel.collection.name,
    ExpenseTypeModel.collection.name,
  ]);

  const dbName = db.databaseName;
  logger.info({ dbName }, "Resetting database from MONGO_URI in .env");

  const collections = await db.listCollections().toArray();
  const dropped: string[] = [];
  for (const { name } of collections) {
    if (preserve.has(name)) continue;
    await db.dropCollection(name);
    dropped.push(name);
  }
  logger.info(
    { dbName, dropped, preserved: [...preserve] },
    "Dropped collections (users and expense types kept)",
  );

  // Explicit reset even if those collections were already dropped above
  await resetPlatformCurrencyAndExchangeMaster();

  await bootstrapData();
  logger.info(
    "Seeded permissions and superadmin — username: superadmin, password: SuperAdmin@123",
  );
  await flushRedisIfConfigured();
  await mongoose.disconnect();
}

main().catch((error) => {
  logger.error(error);
  process.exit(1);
});
