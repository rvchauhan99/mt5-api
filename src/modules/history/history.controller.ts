import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  getTransactionHistory,
  listAuditEntityValuesForLogin,
} from "../reports/reports.service";
import { transactionHistoryQuerySchema } from "../reports/reports.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function userHistoryController(req: Request, res: Response) {
  const query = transactionHistoryQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getTransactionHistory(query, { scope: "login", timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function loginAuditEntitiesController(_req: Request, res: Response) {
  res.status(StatusCodes.OK).json({ success: true, data: listAuditEntityValuesForLogin() });
}
