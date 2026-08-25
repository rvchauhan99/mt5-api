import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  buildPlayerImportErrorCsvBuffer,
  createPlayer,
  exportPlayersToBuffer,
  getPlayerById,
  getSampleCsvBuffer,
  importPlayersFromFile,
  listPlayers,
  updatePlayer,
} from "./player.service";
import { listPlayerQuerySchema } from "./player.validation";
import { subscribePlayerImportEvents } from "./player-import-events";
import {
  createPlayerImportJob,
  getPlayerImportJobErrorCsv,
  getPlayerImportJobStatus,
} from "./player-import-job.service";
import { AppError } from "../../shared/errors/AppError";
import type { ImportRowError } from "./player.service";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

function parseImportRowErrors(error: unknown): ImportRowError[] {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== "object") {
    return [];
  }
  if (!("errors" in error.details)) return [];
  const maybeErrors = (error.details as { errors?: unknown }).errors;
  if (!Array.isArray(maybeErrors)) return [];
  return maybeErrors.filter(
    (entry): entry is ImportRowError =>
      typeof entry === "object" &&
      entry !== null &&
      "row" in entry &&
      "message" in entry &&
      "reason" in entry &&
      "rowData" in entry,
  );
}

function makeImportErrorFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `player-import-errors-${timestamp}.csv`;
}

export async function createPlayerController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const data = await createPlayer(req.body, actorId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function getPlayerByIdController(req: Request, res: Response) {
  const id = typeof req.params.id === "string" ? req.params.id : String(req.params.id ?? "");
  const data = await getPlayerById(id);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listPlayerController(req: Request, res: Response) {
  const query = listPlayerQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listPlayers(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function exportPlayerController(req: Request, res: Response) {
  const query = listPlayerQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportPlayersToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="players-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function samplePlayerCsvController(_req: Request, res: Response) {
  const buffer = getSampleCsvBuffer();
  res.setHeader("Content-Disposition", 'attachment; filename="players-sample.csv"');
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.status(StatusCodes.OK).send(buffer);
}

export async function importPlayerController(req: Request, res: Response) {
  const file = req.file;
  if (!file?.buffer) {
    res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: "file is required (field name: file)" });
    return;
  }
  const actorId = req.user!.userId;
  try {
    const result = await importPlayersFromFile(file.buffer, file.originalname, actorId, req.requestId);
    res.status(StatusCodes.OK).json({ success: true, data: result });
  } catch (error: unknown) {
    if (error instanceof AppError && error.code === "validation_error") {
      const rowErrors = parseImportRowErrors(error);
      if (rowErrors.length > 0) {
        const buffer = buildPlayerImportErrorCsvBuffer(rowErrors);
        res.setHeader("Content-Disposition", `attachment; filename="${makeImportErrorFileName()}"`);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.status(StatusCodes.BAD_REQUEST).send(buffer);
        return;
      }
    }
    throw error;
  }
}

export async function createPlayerImportJobController(req: Request, res: Response) {
  const file = req.file;
  if (!file?.buffer) {
    res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: "file is required (field name: file)" });
    return;
  }
  const actorId = req.user!.userId;
  const result = await createPlayerImportJob({
    fileBuffer: file.buffer,
    fileName: file.originalname,
    fileSize: file.size,
    fileMimeType: file.mimetype,
    actorId,
    requestId: req.requestId,
  });
  res.status(StatusCodes.ACCEPTED).json({ success: true, data: result });
}

export async function getPlayerImportJobStatusController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId : String(req.params.jobId ?? "");
  const result = await getPlayerImportJobStatus(jobId, actorId);
  res.status(StatusCodes.OK).json({ success: true, data: result });
}

export async function downloadPlayerImportJobErrorsCsvController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId : String(req.params.jobId ?? "");
  const result = await getPlayerImportJobErrorCsv(jobId, actorId);
  res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.status(StatusCodes.OK).send(result.buffer);
}

export async function streamPlayerImportJobEventsController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const jobId = typeof req.params.jobId === "string" ? req.params.jobId : String(req.params.jobId ?? "");
  await getPlayerImportJobStatus(jobId, actorId);
  subscribePlayerImportEvents(jobId, res);
}

export async function updatePlayerController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const id = typeof req.params.id === "string" ? req.params.id : String(req.params.id ?? "");
  const data = await updatePlayer(id, req.body, actorId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}
