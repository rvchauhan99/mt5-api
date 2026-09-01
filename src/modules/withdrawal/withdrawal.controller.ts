import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  amendWithdrawal,
  bulkBankerApproveWithdrawals,
  buildWithdrawalImportSampleCsv,
  buildWithdrawalImportSampleXlsx,
  createWithdrawal,
  deleteWithdrawalWithReversal,
  listSavedAccountsForPlayer,
  listWithdrawals,
  updateWithdrawalByExchange,
  updateWithdrawalByBanker,
  updateWithdrawalStatus,
  exportWithdrawalsToBuffer,
  validateWithdrawalImportRows,
} from "./withdrawal.service";
import {
  createWithdrawalImportJob,
  getWithdrawalImportJobErrorCsv,
  getWithdrawalImportJobStatus,
} from "./withdrawal-import-job.service";
import {
  createWithdrawalBulkApproveJob,
  getWithdrawalBulkApproveJobStatus,
} from "./withdrawal-bulk-approve-job.service";
import {
  approvalQueueEventsQuerySchema,
  amendWithdrawalBodySchema,
  bulkBankerApproveBodySchema,
  createBulkBankerApproveJobBodySchema,
  createWithdrawalBodySchema,
  createWithdrawalImportJobBodySchema,
  listWithdrawalQuerySchema,
  exportWithdrawalQuerySchema,
  updateWithdrawalBodySchema,
  updateWithdrawalStatusBodySchema,
  withdrawalBankerPayoutBodySchema,
} from "./withdrawal.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";
import { subscribeApprovalQueueEvents } from "../approval/approval-queue-events";
import { subscribeWithdrawalImportEvents } from "./withdrawal-import-events";
import { subscribeWithdrawalBulkApproveEvents } from "./withdrawal-bulk-approve-events";

export async function createWithdrawalController(req: Request, res: Response) {
  const body = createWithdrawalBodySchema.parse(req.body);
  const timeZone = resolveRequestTimeZone(req);
  const data = await createWithdrawal(body, req.user!.userId, req.requestId, { timeZone });
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function listWithdrawalController(req: Request, res: Response) {
  const query = listWithdrawalQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listWithdrawals(query, { actorId: req.user!.userId, timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function updateWithdrawalExchangeController(req: Request, res: Response) {
  const body = updateWithdrawalBodySchema.parse(req.body);
  const id = String(req.params.id);
  const data = await updateWithdrawalByExchange(id, body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function updateWithdrawalBankerController(req: Request, res: Response) {
  const body = withdrawalBankerPayoutBodySchema.parse(req.body);
  const id = String(req.params.id);
  const timeZone = resolveRequestTimeZone(req);
  const data = await updateWithdrawalByBanker(id, body, req.user!.userId, req.requestId, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function amendWithdrawalController(req: Request, res: Response) {
  const body = amendWithdrawalBodySchema.parse(req.body);
  const id = String(req.params.id);
  const timeZone = resolveRequestTimeZone(req);
  const data = await amendWithdrawal(id, body, req.user!.userId, req.requestId, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function deleteWithdrawalController(req: Request, res: Response) {
  const id = String(req.params.id);
  const data = await deleteWithdrawalWithReversal(id, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function exportWithdrawalController(req: Request, res: Response) {
  const query = exportWithdrawalQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportWithdrawalsToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="withdrawals-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function updateWithdrawalStatusController(req: Request, res: Response) {
  const body = updateWithdrawalStatusBodySchema.parse(req.body);
  const id = String(req.params.id);
  const data = await updateWithdrawalStatus(id, body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listSavedAccountsController(req: Request, res: Response) {
  const playerId = String(req.params.playerId);
  const data = await listSavedAccountsForPlayer(playerId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function streamWithdrawalApprovalQueueEventsController(req: Request, res: Response) {
  const query = approvalQueueEventsQuerySchema.parse(req.query);
  subscribeApprovalQueueEvents("withdrawal", query.view, res);
}

export async function bulkBankerApproveController(req: Request, res: Response) {
  const body = bulkBankerApproveBodySchema.parse(req.body);
  const data = await bulkBankerApproveWithdrawals(body.withdrawalIds, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function createBulkBankerApproveJobController(req: Request, res: Response) {
  const body = createBulkBankerApproveJobBodySchema.parse(req.body);
  const data = await createWithdrawalBulkApproveJob({
    withdrawalIds: body.withdrawalIds,
    actorId: req.user!.userId,
    requestId: req.requestId,
  });
  res.status(StatusCodes.ACCEPTED).json({ success: true, data });
}

export async function getBulkBankerApproveJobController(req: Request, res: Response) {
  const jobId = String(req.params.jobId);
  const data = await getWithdrawalBulkApproveJobStatus(jobId, req.user!.userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function streamBulkBankerApproveJobEventsController(req: Request, res: Response) {
  const jobId = String(req.params.jobId);
  await getWithdrawalBulkApproveJobStatus(jobId, req.user!.userId);
  subscribeWithdrawalBulkApproveEvents(jobId, res);
}

export async function sampleWithdrawalCsvController(req: Request, res: Response) {
  const format = String(req.query.format ?? "csv").toLowerCase();
  if (format === "xlsx") {
    const buffer = await buildWithdrawalImportSampleXlsx();
    res.setHeader("Content-Disposition", 'attachment; filename="withdrawal-import-sample.xlsx"');
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(StatusCodes.OK).send(buffer);
    return;
  }
  if (format !== "csv") {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message: 'Invalid format. Use "csv" or "xlsx".',
    });
    return;
  }
  const buffer = await buildWithdrawalImportSampleCsv();
  res.setHeader("Content-Disposition", 'attachment; filename="withdrawal-import-sample.csv"');
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(StatusCodes.OK).send(buffer);
}

export async function validateWithdrawalImportController(req: Request, res: Response) {
  const file = req.file;
  if (!file?.buffer) {
    res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: "File is required (field name: file)" });
    return;
  }
  const timeZone = resolveRequestTimeZone(req);
  const result = await validateWithdrawalImportRows(file.buffer, file.originalname, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result });
}

export async function createWithdrawalImportJobController(req: Request, res: Response) {
  const body = createWithdrawalImportJobBodySchema.parse(req.body);
  const result = await createWithdrawalImportJob({
    rows: body.rows,
    actorId: req.user!.userId,
    requestId: req.requestId,
  });
  res.status(StatusCodes.ACCEPTED).json({ success: true, data: result });
}

export async function getWithdrawalImportJobController(req: Request, res: Response) {
  const jobId = String(req.params.jobId);
  const result = await getWithdrawalImportJobStatus(jobId, req.user!.userId);
  res.status(StatusCodes.OK).json({ success: true, data: result });
}

export async function streamWithdrawalImportJobEventsController(req: Request, res: Response) {
  const jobId = String(req.params.jobId);
  await getWithdrawalImportJobStatus(jobId, req.user!.userId);
  subscribeWithdrawalImportEvents(jobId, res);
}

export async function downloadWithdrawalImportJobErrorCsvController(req: Request, res: Response) {
  const jobId = String(req.params.jobId);
  const { fileName, buffer } = await getWithdrawalImportJobErrorCsv(jobId, req.user!.userId);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.status(StatusCodes.OK).send(buffer);
}
