import { Queue, Worker, type JobsOptions } from "bullmq";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { getRedisQueueClient } from "../../shared/cache/redis";
import { AppError } from "../../shared/errors/AppError";
import { logger } from "../../shared/logger";
import { createAuditLog } from "../audit/audit.service";
import { bulkBankerApproveWithdrawals } from "./withdrawal.service";
import {
  closeWithdrawalBulkApproveEventStream,
  emitWithdrawalBulkApproveEvent,
} from "./withdrawal-bulk-approve-events";
import {
  WithdrawalBulkApproveJobModel,
  type WithdrawalBulkApproveJobDocument,
  type WithdrawalBulkApproveJobErrorItem,
} from "./withdrawal-bulk-approve-job.model";

const QUEUE_NAME = "withdrawal-bulk-approve-jobs";
const WORKER_ID = `pid-${process.pid}`;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_SAMPLE = 200;

let fallbackWorkerStarted = false;
let fallbackTimer: NodeJS.Timeout | null = null;
let queue: Queue<{ jobId: string }> | null = null;
let redisWorker: Worker<{ jobId: string }> | null = null;

type WithdrawalBulkApproveJobLean = Pick<
  WithdrawalBulkApproveJobDocument,
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

export type WithdrawalBulkApproveJobStatusDto = {
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
  };
  errorSample: WithdrawalBulkApproveJobErrorItem[];
};

function statusDtoFromLean(job: WithdrawalBulkApproveJobLean | null) {
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
    },
    errorSample: job.errorSample ?? [],
  } satisfies WithdrawalBulkApproveJobStatusDto;
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

async function enqueueWithdrawalBulkApproveJob(jobId: string): Promise<void> {
  const q = getQueue();
  if (!q) return;
  const opts: JobsOptions = {
    jobId: `withdrawal-bulk-approve-${jobId}`,
    removeOnComplete: 1000,
    removeOnFail: 2000,
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
  };
  await q.add("process", { jobId }, opts);
}

export async function createWithdrawalBulkApproveJob(input: {
  withdrawalIds: string[];
  actorId: string;
  requestId?: string;
}) {
  const actorOid = new Types.ObjectId(input.actorId);
  const uniqueIds = Array.from(new Set(input.withdrawalIds.filter((id) => Types.ObjectId.isValid(id))));
  if (uniqueIds.length === 0) {
    throw new AppError("validation_error", "At least one valid withdrawal id is required", 400);
  }

  const job = await WithdrawalBulkApproveJobModel.create({
    status: "queued",
    createdBy: actorOid,
    withdrawalIds: uniqueIds,
    progress: {
      totalRows: uniqueIds.length,
      processedRows: 0,
      successRows: 0,
      failedRows: 0,
    },
  });

  await createAuditLog({
    actorId: input.actorId,
    action: "withdrawal.bulk_banker_approve_job.create",
    entity: "withdrawal_bulk_approve_job",
    entityId: job._id.toString(),
    newValue: { status: "queued", totalRows: uniqueIds.length },
    requestId: input.requestId,
  });

  try {
    await enqueueWithdrawalBulkApproveJob(job._id.toString());
  } catch (error) {
    logger.warn({ err: error, jobId: job._id.toString() }, "Unable to enqueue withdrawal bulk approve in redis queue");
  }

  return { jobId: job._id.toString(), status: job.status };
}

export async function getWithdrawalBulkApproveJobStatus(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await WithdrawalBulkApproveJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Bulk approve job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this bulk approve job", 403);
  }
  return statusDtoFromLean(job as unknown as WithdrawalBulkApproveJobLean | null);
}

async function claimQueuedJob(jobId?: string) {
  const staleTime = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  return WithdrawalBulkApproveJobModel.findOneAndUpdate(
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
  const fresh = await WithdrawalBulkApproveJobModel.findById(jobId).lean();
  if (!fresh) return;
  emitWithdrawalBulkApproveEvent({
    jobId,
    status: fresh.status,
    totalRows: fresh.progress.totalRows,
    processedRows: fresh.progress.processedRows,
    successRows: fresh.progress.successRows,
    failedRows: fresh.progress.failedRows,
    message: fresh.failureReason,
  });
}

async function processSingleJob(jobId: string) {
  const job = await WithdrawalBulkApproveJobModel.findById(jobId);
  if (!job) return;

  try {
    const totalRows = job.withdrawalIds.length;
    await WithdrawalBulkApproveJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          "progress.totalRows": totalRows,
          "progress.processedRows": 0,
          "progress.successRows": 0,
          "progress.failedRows": 0,
        },
      },
    );
    await emitCurrentProgress(jobId);

    const result = await bulkBankerApproveWithdrawals(job.withdrawalIds, job.createdBy.toString(), undefined, {
      onProgress: async (progress) => {
        await WithdrawalBulkApproveJobModel.updateOne(
          { _id: job._id },
          {
            $set: {
              "progress.totalRows": progress.totalRows,
              "progress.processedRows": progress.processedRows,
              "progress.successRows": progress.successRows,
              "progress.failedRows": progress.failedRows,
              "lock.heartbeatAt": new Date(),
            },
          },
        );
        emitWithdrawalBulkApproveEvent({
          jobId,
          status: "processing",
          totalRows: progress.totalRows,
          processedRows: progress.processedRows,
          successRows: progress.successRows,
          failedRows: progress.failedRows,
        });
      },
    });

    const isFailed = result.approved === 0 && result.failed.length > 0;
    await WithdrawalBulkApproveJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: isFailed ? "failed" : "completed",
          finishedAt: new Date(),
          failureReason: isFailed ? "All selected rows failed during bulk settlement" : undefined,
          "progress.totalRows": totalRows,
          "progress.processedRows": totalRows,
          "progress.successRows": result.approved,
          "progress.failedRows": result.failed.length,
          errorRows: result.failed,
          errorSample: result.failed.slice(0, MAX_ERROR_SAMPLE),
          withdrawalIds: [],
        },
        $unset: { lock: 1 },
      },
    );

    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: isFailed ? "withdrawal.bulk_banker_approve_job.failed" : "withdrawal.bulk_banker_approve_job.complete",
      entity: "withdrawal_bulk_approve_job",
      entityId: jobId,
      newValue: {
        totalRows,
        approved: result.approved,
        failed: result.failed.length,
      },
    });
    await emitCurrentProgress(jobId);
    closeWithdrawalBulkApproveEventStream(jobId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Bulk settlement processing failed";
    await WithdrawalBulkApproveJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          failureReason: message,
          withdrawalIds: [],
        },
        $unset: { lock: 1 },
      },
    );
    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: "withdrawal.bulk_banker_approve_job.failed",
      entity: "withdrawal_bulk_approve_job",
      entityId: jobId,
      newValue: { message },
    });
    await emitCurrentProgress(jobId);
    closeWithdrawalBulkApproveEventStream(jobId);
    logger.error({ err, jobId }, "Withdrawal bulk approve job failed");
  }
}

async function workerTick() {
  if (env.redisUrl) return;
  const claimed = await claimQueuedJob();
  if (!claimed) return;
  await processSingleJob(claimed._id.toString());
}

export function startWithdrawalBulkApproveWorker() {
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
        logger.error({ queue: QUEUE_NAME, jobId: job?.id, err }, "Withdrawal bulk approve queue job failed");
      });
    }
  }

  if (fallbackWorkerStarted) return;
  fallbackWorkerStarted = true;
  fallbackTimer = setInterval(() => {
    void workerTick().catch((error) => {
      logger.error({ err: error }, "Withdrawal bulk approve fallback worker tick failed");
    });
  }, POLL_INTERVAL_MS);
  void workerTick().catch((error) => {
    logger.error({ err: error }, "Withdrawal bulk approve fallback worker startup run failed");
  });
}

export async function stopWithdrawalBulkApproveWorker() {
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
