import "dotenv/config";
import { createApp } from "./app";
import { env } from "./config/env";
import { connectDb } from "./shared/db/connect";
import { bootstrapData } from "./shared/db/bootstrap";
import { runMigrations } from "./migrations";
import { logger } from "./shared/logger";
import { startPlayerImportWorker, stopPlayerImportWorker } from "./modules/player/player-import-job.service";
import { startDepositImportWorker, stopDepositImportWorker } from "./modules/deposit/deposit-import-job.service";
import {
  startDepositBulkExchangeApproveWorker,
  stopDepositBulkExchangeApproveWorker,
} from "./modules/deposit/deposit-bulk-exchange-approve-job.service";
import {
  startWithdrawalImportWorker,
  stopWithdrawalImportWorker,
} from "./modules/withdrawal/withdrawal-import-job.service";
import {
  startWithdrawalBulkApproveWorker,
  stopWithdrawalBulkApproveWorker,
} from "./modules/withdrawal/withdrawal-bulk-approve-job.service";
import { startQueueWorkers, stopQueueWorkers } from "./shared/queue/queue";

async function start() {
  await connectDb();
  await runMigrations();
  await bootstrapData();

  const app = createApp();
  startPlayerImportWorker();
  startDepositImportWorker();
  startDepositBulkExchangeApproveWorker();
  startWithdrawalImportWorker();
  startWithdrawalBulkApproveWorker();
  startQueueWorkers();
  app.listen(env.port, () => {
    logger.info(`API server running on port ${env.port}`);
  });
}

start().catch((error) => {
  logger.error(error);
  stopPlayerImportWorker();
  void stopDepositImportWorker();
  void stopDepositBulkExchangeApproveWorker();
  void stopWithdrawalImportWorker();
  void stopWithdrawalBulkApproveWorker();
  void stopQueueWorkers();
  process.exit(1);
});
