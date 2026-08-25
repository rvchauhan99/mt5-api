import { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import { logger } from "../../shared/logger";
import { createAuditLog } from "../audit/audit.service";
import {
  applyPlayerImportRows,
  buildPlayerImportErrorCsvBuffer,
  parsePlayerImportFile,
  type ImportRowError,
} from "./player.service";
import { closePlayerImportEventStream, emitPlayerImportEvent } from "./player-import-events";
import { PlayerImportJobModel, type PlayerImportJobDocument } from "./player-import-job.model";

const WORKER_ID = `pid-${process.pid}`;
const LOCK_STALE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_ERROR_SAMPLE = 200;
const CHUNK_SIZE = 750;

let workerStarted = false;
let timer: NodeJS.Timeout | null = null;

type CreateJobInput = {
  fileBuffer: Buffer;
  fileName: string;
  fileSize: number;
  fileMimeType: string;
  actorId: string;
  requestId?: string;
};

type PlayerImportJobLean = Pick<
  PlayerImportJobDocument,
  | "_id"
  | "status"
  | "fileName"
  | "createdBy"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "failureReason"
  | "progress"
  | "errorSample"
  | "errorRows"
>;

export type PlayerImportJobStatusDto = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  fileName: string;
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
  errorSample: ImportRowError[];
  errorCsvAvailable: boolean;
};

function statusDtoFromLean(job: PlayerImportJobLean | null) {
  if (!job) return null;
  return {
    id: job._id.toString(),
    status: job.status,
    fileName: job.fileName,
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
  } satisfies PlayerImportJobStatusDto;
}

export async function createPlayerImportJob(input: CreateJobInput) {
  const actorOid = new Types.ObjectId(input.actorId);
  const job = await PlayerImportJobModel.create({
    status: "queued",
    fileName: input.fileName,
    fileSize: input.fileSize,
    fileMimeType: input.fileMimeType,
    fileBuffer: input.fileBuffer,
    createdBy: actorOid,
  });
  await createAuditLog({
    actorId: input.actorId,
    action: "player.import_job.create",
    entity: "player_import_job",
    entityId: job._id.toString(),
    newValue: {
      status: "queued",
      fileName: input.fileName,
      fileSize: input.fileSize,
    },
    requestId: input.requestId,
  });
  return { jobId: job._id.toString(), status: job.status };
}

export async function getPlayerImportJobStatus(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await PlayerImportJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Import job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this import job", 403);
  }
  return statusDtoFromLean(job as unknown as PlayerImportJobLean | null);
}

export async function getPlayerImportJobErrorCsv(jobId: string, actorId: string) {
  if (!Types.ObjectId.isValid(jobId)) {
    throw new AppError("validation_error", "Invalid job id", 400);
  }
  const job = await PlayerImportJobModel.findById(jobId).lean();
  if (!job) {
    throw new AppError("not_found", "Import job not found", 404);
  }
  if (String(job.createdBy) !== actorId) {
    throw new AppError("auth_error", "You do not have access to this import job", 403);
  }
  if (job.status !== "failed") {
    throw new AppError("validation_error", "Error CSV is available only for failed import jobs", 409);
  }
  const errors = (job.errorRows ?? []) as ImportRowError[];
  if (errors.length === 0) {
    throw new AppError("not_found", "No row-level validation errors found for this import job", 404);
  }

  return {
    fileName: `player-import-errors-${jobId}.csv`,
    buffer: buildPlayerImportErrorCsvBuffer(errors),
  };
}

async function claimNextJob() {
  const staleTime = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  return PlayerImportJobModel.findOneAndUpdate(
    {
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
  const fresh = await PlayerImportJobModel.findById(jobId).lean();
  if (!fresh) return;
  emitPlayerImportEvent({
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
  const job = await PlayerImportJobModel.findById(jobId);
  if (!job) return;
  try {
    const { parsedRows, skipped, totalRows } = await parsePlayerImportFile(job.fileBuffer, job.fileName);
    await PlayerImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          "progress.totalRows": totalRows,
          "progress.skippedRows": skipped,
          "progress.processedRows": skipped,
        },
      },
    );
    await emitCurrentProgress(jobId);

    const { created, updated } = await applyPlayerImportRows(parsedRows, job.createdBy.toString(), {
      chunkSize: CHUNK_SIZE,
      skippedRows: skipped,
      onProgress: async (progress) => {
        await PlayerImportJobModel.updateOne(
          { _id: job._id },
          {
            $set: {
              "progress.totalRows": progress.totalRows,
              "progress.processedRows": progress.processedRows,
              "progress.successRows": progress.successRows,
              "progress.failedRows": 0,
              "progress.skippedRows": progress.skippedRows,
              "lock.heartbeatAt": new Date(),
            },
          },
        );
        emitPlayerImportEvent({
          jobId,
          status: "processing",
          totalRows: progress.totalRows,
          processedRows: progress.processedRows,
          successRows: progress.successRows,
          failedRows: 0,
          skippedRows: progress.skippedRows,
        });
      },
    });

    await PlayerImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "completed",
          finishedAt: new Date(),
          "progress.successRows": created + updated,
          "progress.failedRows": 0,
          "progress.processedRows": totalRows,
          errorRows: [],
          errorSample: [],
          fileBuffer: Buffer.alloc(0),
        },
        $unset: { lock: 1 },
      },
    );

    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: "player.import_job.complete",
      entity: "player_import_job",
      entityId: jobId,
      newValue: { created, updated, skipped, totalRows },
    });
    await emitCurrentProgress(jobId);
    closePlayerImportEventStream(jobId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Import processing failed";
    const details =
      err instanceof AppError && err.details && typeof err.details === "object" && "errors" in err.details
        ? ((err.details as { errors?: ImportRowError[] }).errors ?? [])
        : [];
    await PlayerImportJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          failureReason: message,
          "progress.failedRows": details.length,
          "progress.processedRows": Math.max(job.progress.processedRows, details.length),
          errorSample: details.slice(0, MAX_ERROR_SAMPLE),
          errorRows: details,
          fileBuffer: Buffer.alloc(0),
        },
        $unset: { lock: 1 },
      },
    );
    await createAuditLog({
      actorId: job.createdBy.toString(),
      action: "player.import_job.failed",
      entity: "player_import_job",
      entityId: jobId,
      newValue: { message },
    });
    await emitCurrentProgress(jobId);
    closePlayerImportEventStream(jobId);
    logger.error({ err, jobId }, "Player import job failed");
  }
}

async function workerTick() {
  const claimed = await claimNextJob();
  if (!claimed) return;
  await processSingleJob(claimed._id.toString());
}

export function startPlayerImportWorker() {
  if (workerStarted) return;
  workerStarted = true;
  timer = setInterval(() => {
    void workerTick().catch((error) => {
      logger.error({ err: error }, "Player import worker tick failed");
    });
  }, POLL_INTERVAL_MS);
  void workerTick().catch((error) => {
    logger.error({ err: error }, "Player import worker startup run failed");
  });
}

export function stopPlayerImportWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  workerStarted = false;
}
