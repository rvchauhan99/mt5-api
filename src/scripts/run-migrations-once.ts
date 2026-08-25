import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../shared/db/connect";
import { runMigrations } from "../migrations";
import { logger } from "../shared/logger";

async function main() {
  await connectDb();
  await runMigrations();
  logger.info("migrations finished");
  await mongoose.disconnect();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
