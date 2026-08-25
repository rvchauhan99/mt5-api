import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  createLiabilityEntryBodySchema,
  createLiabilityPersonBodySchema,
  liabilityLedgerQuerySchema,
  liabilityReportQuerySchema,
  liabilityPersonIdParamSchema,
  listLiabilityEntryQuerySchema,
  listLiabilityPersonQuerySchema,
  updateLiabilityPersonBodySchema,
} from "./liability.validation";
import {
  createLiabilityEntry,
  createLiabilityPerson,
  exportLiabilityEntriesToBuffer,
  exportLiabilityLedgerToBuffer,
  exportLiabilityPersonsToBuffer,
  getLiabilityPersonLedger,
  getLiabilityReportPersonWise,
  getLiabilityReportSummary,
  listLiabilityEntries,
  listLiabilityPersons,
  updateLiabilityPerson,
} from "./liability.service";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function createLiabilityPersonController(req: Request, res: Response) {
  const body = createLiabilityPersonBodySchema.parse(req.body);
  const data = await createLiabilityPerson(body, req.user!.userId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function updateLiabilityPersonController(req: Request, res: Response) {
  const body = updateLiabilityPersonBodySchema.parse(req.body);
  const { id } = liabilityPersonIdParamSchema.parse(req.params);
  const data = await updateLiabilityPerson(id, body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listLiabilityPersonController(req: Request, res: Response) {
  const query = listLiabilityPersonQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listLiabilityPersons(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function exportLiabilityPersonController(req: Request, res: Response) {
  const query = listLiabilityPersonQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportLiabilityPersonsToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="liability-persons-export.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.status(StatusCodes.OK).send(buffer);
}

export async function createLiabilityEntryController(req: Request, res: Response) {
  const body = createLiabilityEntryBodySchema.parse(req.body);
  const data = await createLiabilityEntry(body, req.user!.userId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function listLiabilityEntryController(req: Request, res: Response) {
  const query = listLiabilityEntryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listLiabilityEntries(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function exportLiabilityEntryController(req: Request, res: Response) {
  const query = listLiabilityEntryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportLiabilityEntriesToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="liability-entries-export.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.status(StatusCodes.OK).send(buffer);
}

export async function liabilityPersonLedgerController(req: Request, res: Response) {
  const { id } = liabilityPersonIdParamSchema.parse(req.params);
  const query = liabilityLedgerQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getLiabilityPersonLedger(id, query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function exportLiabilityLedgerController(req: Request, res: Response) {
  const { id } = liabilityPersonIdParamSchema.parse(req.params);
  const query = liabilityLedgerQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportLiabilityLedgerToBuffer(id, query, { timeZone });
  res.setHeader("Content-Disposition", `attachment; filename="liability-ledger-${id}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.status(StatusCodes.OK).send(buffer);
}

export async function liabilitySummaryReportController(_req: Request, res: Response) {
  const query = liabilityReportQuerySchema.parse(_req.query);
  const data = await getLiabilityReportSummary(query);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function liabilityPersonWiseReportController(_req: Request, res: Response) {
  const query = liabilityReportQuerySchema.parse(_req.query);
  const data = await getLiabilityReportPersonWise(query);
  res.status(StatusCodes.OK).json({ success: true, data });
}
