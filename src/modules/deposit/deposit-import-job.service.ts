import { Queue, Worker, type JobsOptions } from "bullmq";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { getRedisQueueClient } from "../../shared/cache/redis";
import { AppError } from "../../shared/errors/AppError";
import { logger } from "../../shared/logger";
import { createAuditLog } from "../audit/audit.service";
import {
  buildDepositImportErrorCsv,
  commitDepositImportRows,
  DEPOSIT_IMPORT_CHUNK_SIZE,
  type DepositImportCommitProgress,
} from "./deposit.service";
import { closeDepositImportEventStream, emitDepositImportEvent } from "./deposit-import-events";
import {
  DepositImportJobModel,
  type DepositImportJobDocument,
  type DepositImportJobErrorItem,
} from "./deposit-import-job.model";

const QUEUE_NAME = "deposit-import-jobs";
const WORKER_ID = `pid-${process.pid}`;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_SAMPLE = 200;

let fallbackWorkerStarted = false;
let fallbackTimer: NodeJS.Timeout | null = null;
let queue: Queue<{ jobId: string }> | null = null;
let redisWorker: Worker<{ jobId: string }> | null = null;

type DepositImportJobLean = Pick<
  DepositImportJobDocument,
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

export type DepositImportJobStatusDto = {
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
  errorSample: DepositImportJobErrorItem[];
  errorCsvAvailable: boolean;
};

type CreateDepositImportJobInput = {
  rows: Array<{
    utr: string;
    amount: number;
    entryAt?: string;
    settlementAccountType: "bank" | "person";
    bankId?: string;
    liabilityPersonId?: string;
    playerMongoId?: string;
    bonusAmount?: number;
    totalAmount?: number;
  }>;
  actorId: string;
  requestId?: string;
};

function statusDtoFromLean(job: DepositImportJobLean | null) {
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
  } satisfies DepositImportJobStatusDto;
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

async function enqueueDepositImportJob(jobId: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  const opts: JobsOptions = {
    jobId: `deposit-import-${jobId}`,
    removeOnComplete: 1000,
    removeOnFail: 2000,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  };
  await q.add("process", { jobId }, opts);
}

export async function createDepositImportJob(input: CreateDepositImportJobInput) {
  const actorOid = new Types.ObjectId(input.actorId);
  const rows = input.rows.map((row) => ({
    utr: row.utr,
    amount: row.amount,
    entryAt: row.entryAt,
    settlementAccountType: row.settlementAccountType,
    bankId: row.bankId,
    liabilityPersonId: row.liabilityPersonId,
    playerMongoId: row.playerMongoId,
    bonusAmount: row.bonusAmount,
    totalAmount: row.totalAmount,
  }));
  const job = await DepositImportJobModel.create({
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
    action: "deposit.import_job.create",
    entity: "deposit_import_job",
    entityId: job._id.toString(),
    newValue: {
      status: "queued",
      totalRows: rows.length,
    },
    requestId: input.requestId,
  });

  try {
    await enqueueDepositImportJob(job._id.toString());
  } catch (error) {
    logger.warn({ err: error, jobId: job._id.toString() }, "Unable to enqueue deposit import in redis queue");
  }

  return { jobId: job._id.toString(), status: job.status };
}

export async function getDepositImportJobStatus(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await DepositImportJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Import job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this import job", 403);
  }
  return statusDtoFromLean(job as unknown as DepositImportJobLean | null);
}

export async function getDepositImportJobErrorCsv(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await DepositImportJobModel.findById(jobId).lean();
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
    fileName: `deposit-import-errors-${jobId}.csv`,
    buffer: buildDepositImportErrorCsv(
      errors.map((item) => ({
        row: item.row,
        dateTime: "",
        settlementType: "",
        bankAccountNumber: "",
        liablePersonName: "",
        operatedCurrency: "",
        amount: "",
        exchangeRate: "",
        platformAmount: "",
        playerId: "",
        utr: item.utr,
        errors: [item.error],
      })),
    ),
  };
}

async function claimQueuedJob(jobId?: string) {
  const staleTime = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  return DepositImportJobModel.findOneAndUpdate(
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
  const fresh = await DepositImportJobModel.findById(jobId).lean();
  if (!fresh) return;
  emitDepositImportEvent({
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
  const job = await DepositImportJobModel.findById(jobId);
  if (!job) return;
  try {
    const totalRows = job.rows.length;
    await DepositImportJobModel.updateOne(
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

    const result = await commitDepositImportRows(job.rows, job.createdBy.toString(), undefined, {
      chunkSize: DEPOSIT_IMPORT_CHUNK_SIZE,
      onProgress: async (progress: DepositImportCommitProgress) => {
        await DepositImportJobModel.updateOne(
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
        emitDepositImportEvent({
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
    await DepositImportJobModel.updateOne(
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
      action: isFailed ? "deposit.import_job.failed" : "deposit.import_job.complete",
      entity: "deposit_import_job",
      entityId: jobId,
      newValue: {
        totalRows,
        created: result.created,
        errors: result.errors.length,
      },
    });
    await emitCurrentProgress(jobId);
    closeDepositImportEventStream(jobId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Import processing failed";
    await DepositImportJobModel.updateOne(
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
      action: "deposit.import_job.failed",
      entity: "deposit_import_job",
      entityId: jobId,
      newValue: { message },
    });
    await emitCurrentProgress(jobId);
    closeDepositImportEventStream(jobId);
    logger.error({ err, jobId }, "Deposit import job failed");
  }
}

async function workerTick() {
  if (env.redisUrl) return;
  const claimed = await claimQueuedJob();
  if (!claimed) return;
  await processSingleJob(claimed._id.toString());
}

export function startDepositImportWorker() {
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
        logger.error({ queue: QUEUE_NAME, jobId: job?.id, err }, "Deposit import queue job failed");
      });
    }
  }

  if (fallbackWorkerStarted) return;
  fallbackWorkerStarted = true;
  fallbackTimer = setInterval(() => {
    void workerTick().catch((error) => {
      logger.error({ err: error }, "Deposit import fallback worker tick failed");
    });
  }, POLL_INTERVAL_MS);
  void workerTick().catch((error) => {
    logger.error({ err: error }, "Deposit import fallback worker startup run failed");
  });
}

export async function stopDepositImportWorker() {
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
