import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { Types } from "mongoose";
import {
  createBalanceSheetSnapshot,
  exportBalanceSheetDrilldownToBuffer,
  exportBalanceSheetToBuffer,
  getBalanceSheet,
  getBalanceSheetDrilldown,
  getBalanceSheetSummary,
  listBalanceSheetGroups,
} from "./balance-sheet.service";
import {
  exportBalanceSheetMovementsToBuffer,
  getBalanceSheetMovements,
} from "./balance-sheet-movements.service";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";
import { AppError } from "../../shared/errors/AppError";
import {
  balanceSheetDrilldownExportQuerySchema,
  balanceSheetDrilldownQuerySchema,
  balanceSheetExportQuerySchema,
  balanceSheetMovementsQuerySchema,
  balanceSheetQuerySchema,
  balanceSheetSummaryQuerySchema,
  createBalanceSheetSnapshotBodySchema,
} from "./balance-sheet.validation";

export async function balanceSheetController(req: Request, res: Response) {
  const query = balanceSheetQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getBalanceSheet(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function balanceSheetSummaryController(req: Request, res: Response) {
  const query = balanceSheetSummaryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getBalanceSheetSummary(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function balanceSheetExportController(req: Request, res: Response) {
  const query = balanceSheetExportQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportBalanceSheetToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="balance-sheet.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function balanceSheetGroupsController(_req: Request, res: Response) {
  const data = await listBalanceSheetGroups();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function balanceSheetDrilldownController(req: Request, res: Response) {
  const query = balanceSheetDrilldownQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getBalanceSheetDrilldown(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function balanceSheetDrilldownExportController(req: Request, res: Response) {
  const query = balanceSheetDrilldownExportQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportBalanceSheetDrilldownToBuffer(query, { timeZone });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="balance-sheet-ledger-${query.ledgerId}.xlsx"`,
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function createBalanceSheetSnapshotController(req: Request, res: Response) {
  const body = createBalanceSheetSnapshotBodySchema.parse(req.body);
  const timeZone = resolveRequestTimeZone(req);
  const actorId = req.user?.userId;
  if (!actorId || !Types.ObjectId.isValid(actorId)) {
    throw new AppError("UNAUTHORIZED", "Unauthorized", StatusCodes.UNAUTHORIZED);
  }
  const data = await createBalanceSheetSnapshot(body, new Types.ObjectId(actorId), { timeZone });
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function balanceSheetMovementsController(req: Request, res: Response) {
  const query = balanceSheetMovementsQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getBalanceSheetMovements(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function balanceSheetMovementsExportController(req: Request, res: Response) {
  const query = balanceSheetMovementsQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportBalanceSheetMovementsToBuffer(query, { timeZone });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="balance-sheet-movements-${query.type}.xlsx"`,
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}
