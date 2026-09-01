import { Queue, Worker, type JobsOptions } from "bullmq";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { getRedisQueueClient } from "../../shared/cache/redis";
import { AppError } from "../../shared/errors/AppError";
import { logger } from "../../shared/logger";
import { createAuditLog } from "../audit/audit.service";
import {
  buildWithdrawalImportErrorCsv,
  commitWithdrawalImportRows,
  WITHDRAWAL_IMPORT_CHUNK_SIZE,
  type WithdrawalImportCommitProgress,
} from "./withdrawal-import.service";
import { closeWithdrawalImportEventStream, emitWithdrawalImportEvent } from "./withdrawal-import-events";
import {
  WithdrawalImportJobModel,
  type WithdrawalImportJobDocument,
  type WithdrawalImportJobErrorItem,
} from "./withdrawal-import-job.model";

const QUEUE_NAME = "withdrawal-import-jobs";
const WORKER_ID = `pid-${process.pid}`;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_SAMPLE = 200;

let fallbackWorkerStarted = false;
let fallbackTimer: NodeJS.Timeout | null = null;
let queue: Queue<{ jobId: string }> | null = null;
let redisWorker: Worker<{ jobId: string }> | null = null;

type WithdrawalImportJobLean = Pick<
  WithdrawalImportJobDocument,
  | "_id"
  | "status"
  | "createdBy"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "failureReason"
  | "progress"
  | "errorSample"
  | "errorRows"
>;

export type WithdrawalImportJobStatusDto = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  failureReason?: string;
  progress: {
    totalRows: number;
    processedRows: number;
    successRows: number;
    failedRows: number;
    skippedRows: number;
  };
  errorSample: WithdrawalImportJobErrorItem[];
  errorCsvAvailable: boolean;
};

type CreateWithdrawalImportJobInput = {
  rows: Array<{
    playerMongoId: string;
    accountNumber: string;
    accountHolderName: string;
    bankName: string;
    ifsc: string;
    amount: number;
    reverseBonus: number;
    requestedAt?: string;
    payoutUtr?: string;
    payoutSettlementType?: "bank" | "person";
    payoutBankId?: string;
    payoutLiabilityPersonId?: string;
  }>;
  actorId: string;
  requestId?: string;
};

function statusDtoFromLean(job: WithdrawalImportJobLean | null) {
  if (!job) return null;
  return {
    id: job._id.toString(),
    status: job.status,
    createdBy: String(job.createdBy),
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    failureReason: job.failureReason,
    progress: {
      totalRows: job.progress.totalRows,
      processedRows: job.progress.processedRows,
      successRows: job.progress.successRows,
      failedRows: job.progress.failedRows,
      skippedRows: job.progress.skippedRows,
    },
    errorSample: job.errorSample ?? [],
    errorCsvAvailable: (job.errorRows?.length ?? 0) > 0,
  } satisfies WithdrawalImportJobStatusDto;
}

function getQueue(): Queue<{ jobId: string }> | null {
  if (!env.redisUrl) return null;
  if (!queue) {
    const connection = getRedisQueueClient();
    if (!connection) return null;
    queue = new Queue<{ jobId: string }>(QUEUE_NAME, { connection });
  }
  return queue;
}

async function enqueueWithdrawalImportJob(jobId: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  const opts: JobsOptions = {
    jobId: `withdrawal-import-${jobId}`,
    removeOnComplete: 1000,
    removeOnFail: 2000,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  };
  await q.add("process", { jobId }, opts);
}

export async function createWithdrawalImportJob(input: CreateWithdrawalImportJobInput) {
  const actorOid = new Types.ObjectId(input.actorId);
  const rows = input.rows.map((row) => ({ ...row }));
  const job = await WithdrawalImportJobModel.create({
    status: "queued",
    createdBy: actorOid,
    rows,
    progress: {
      totalRows: rows.length,
      processedRows: 0,
      successRows: 0,
      failedRows: 0,
      skippedRows: 0,
    },
  });
  await createAuditLog({
    actorId: input.actorId,
    action: "withdrawal.import_job.create",
    entity: "withdrawal_import_job",
    entityId: job._id.toString(),
    newValue: {
      status: "queued",
      totalRows: rows.length,
    },
    requestId: input.requestId,
  });

  try {
    await enqueueWithdrawalImportJob(job._id.toString());
  } catch (error) {
    logger.warn({ err: error, jobId: job._id.toString() }, "Unable to enqueue withdrawal import in redis queue");
  }

  return { jobId: job._id.toString(), status: job.status };
}

export async function getWithdrawalImportJobStatus(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await WithdrawalImportJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Import job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this import job", 403);
  }
  return statusDtoFromLean(job as unknown as WithdrawalImportJobLean | null);
}

export async function getWithdrawalImportJobErrorCsv(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await WithdrawalImportJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Import job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this import job", 403);
  }
  if (job.status !== "failed") {
    throw new AppError("validation_error", "Error CSV is available only for failed import jobs", 409);
  }
  const errors = job.errorRows ?? [];
  if (errors.length === 0) {
    throw new AppError("not_found", "No row-level import errors found for this import job", 404);
  }
  return {
    fileName: `withdrawal-import-errors-${jobId}.csv`,
    buffer: buildWithdrawalImportErrorCsv(
      errors.map((item) => ({
        row: item.row,
        dateTime: "",
        playerId: "",
        accountNumber: "",
        accountHolderName: "",
        bankName: "",
        ifsc: "",
        operatedCurrency: "",
        withdrawalAmount: "",
        exchangeRate: "",
        platformAmount: "",
        payoutUtr: item.utr,
        payoutSettlementType: "",
        payoutBank: "",
        payoutLiablePersonName: "",
        errors: [item.error],
      })),
    ),
  };
}

async function claimQueuedJob(jobId?: string) {
  const staleTime = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  return WithdrawalImportJobModel.findOneAndUpdate(
    {
      ...(jobId ? { _id: new Types.ObjectId(jobId) } : {}),
      status: "queued",
      $or: [{ lock: { $exists: false } }, { "lock.heartbeatAt": { $lt: staleTime } }],
    },
    {
      $set: {
        status: "processing",
        startedAt: now,
        lock: { lockedBy: WORKER_ID, lockedAt: now, heartbeatAt: now },
      },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
}

async function emitCurrentProgress(jobId: string) {
  const fresh = await WithdrawalImportJobModel.findById(jobId).lean();
  if (!fresh) return;
  emitWithdrawalImportEvent({
    jobId,
    status: fresh.status,
    totalRows: fresh.progress.totalRows,
    processedRows: fresh.progress.processedRows,
    successRows: fresh.progress.successRows,
    failedRows: fresh.progress.failedRows,
    skippedRows: fresh.progress.skippedRows,
    message: fresh.failureReason,
  });
}

async function processSingleJob(jobId: string) {
  const job = await WithdrawalImportJobModel.findById(jobId);
  if (!job) return;
  try {
    const totalRows = job.rows.length;
    await WithdrawalImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          "progress.totalRows": totalRows,
          "progress.processedRows": 0,
          "progress.successRows": 0,
          "progress.failedRows": 0,
          "progress.skippedRows": 0,
        },
      },
    );
    await emitCurrentProgress(jobId);

    const result = await commitWithdrawalImportRows(job.rows, job.createdBy.toString(), undefined, {
      chunkSize: WITHDRAWAL_IMPORT_CHUNK_SIZE,
      onProgress: async (progress: WithdrawalImportCommitProgress) => {
        await WithdrawalImportJobModel.updateOne(
          { _id: job._id },
          {
            $set: {
              "progress.totalRows": progress.totalRows,
              "progress.processedRows": progress.processedRows,
              "progress.successRows": progress.created,
              "progress.failedRows": progress.errors.length,
              "progress.skippedRows": 0,
              "lock.heartbeatAt": new Date(),
            },
          },
        );
        emitWithdrawalImportEvent({
          jobId,
          status: "processing",
          totalRows: progress.totalRows,
          processedRows: progress.processedRows,
          successRows: progress.created,
          failedRows: progress.errors.length,
          skippedRows: 0,
        });
      },
    });

    const isFailed = result.created === 0 && result.errors.length > 0;
    await WithdrawalImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: isFailed ? "failed" : "completed",
          finishedAt: new Date(),
          failureReason: isFailed ? "All rows failed during import" : undefined,
          "progress.totalRows": totalRows,
          "progress.processedRows": totalRows,
          "progress.successRows": result.created,
          "progress.failedRows": result.errors.length,
          "progress.skippedRows": 0,
          errorRows: result.errors,
          errorSample: result.errors.slice(0, MAX_ERROR_SAMPLE),
          rows: [],
        },
        $unset: { lock: 1 },
      },
    );

    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: isFailed ? "withdrawal.import_job.failed" : "withdrawal.import_job.complete",
      entity: "withdrawal_import_job",
      entityId: jobId,
      newValue: {
        totalRows,
        created: result.created,
        errors: result.errors.length,
      },
    });
    await emitCurrentProgress(jobId);
    closeWithdrawalImportEventStream(jobId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Import processing failed";
    await WithdrawalImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          failureReason: message,
          rows: [],
        },
        $unset: { lock: 1 },
      },
    );
    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: "withdrawal.import_job.failed",
      entity: "withdrawal_import_job",
      entityId: jobId,
      newValue: { message },
    });
    await emitCurrentProgress(jobId);
    closeWithdrawalImportEventStream(jobId);
    logger.error({ err, jobId }, "Withdrawal import job failed");
  }
}

async function workerTick() {
  if (env.redisUrl) return;
  const claimed = await claimQueuedJob();
  if (!claimed) return;
  await processSingleJob(claimed._id.toString());
}

export function startWithdrawalImportWorker() {
  if (env.redisUrl && !redisWorker) {
    const connection = getRedisQueueClient();
    if (connection) {
      redisWorker = new Worker<{ jobId: string }>(
        QUEUE_NAME,
        async (job) => {
          const claimed = await claimQueuedJob(job.data.jobId);
          if (!claimed) return;
          await processSingleJob(claimed._id.toString());
        },
        { connection, concurrency: 2 },
      );
      redisWorker.on("failed", (job, err) => {
        logger.error({ queue: QUEUE_NAME, jobId: job?.id, err }, "Withdrawal import queue job failed");
      });
    }
  }

  if (fallbackWorkerStarted) return;
  fallbackWorkerStarted = true;
  fallbackTimer = setInterval(() => {
    void workerTick().catch((error) => {
      logger.error({ err: error }, "Withdrawal import fallback worker tick failed");
    });
  }, POLL_INTERVAL_MS);
  void workerTick().catch((error) => {
    logger.error({ err: error }, "Withdrawal import fallback worker startup run failed");
  });
}

export async function stopWithdrawalImportWorker() {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  fallbackWorkerStarted = false;

  await redisWorker?.close();
  redisWorker = null;
  await queue?.close();
  queue = null;
}
