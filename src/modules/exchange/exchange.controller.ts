import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  createExchange,
  exportExchangesToBuffer,
  getExchangeStatement,
  getExchangeById,
  listExchanges,
  updateExchange,
} from "./exchange.service";
import { exchangeStatementQuerySchema, listExchangeQuerySchema } from "./exchange.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function createExchangeController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const data = await createExchange(req.body, actorId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function listExchangeController(req: Request, res: Response) {
  const query = listExchangeQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await listExchanges(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function exportExchangeController(req: Request, res: Response) {
  const query = listExchangeQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportExchangesToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="exchanges-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function getExchangeController(req: Request, res: Response) {
  const data = await getExchangeById(String(req.params.id));
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function updateExchangeController(req: Request, res: Response) {
  const actorId = req.user!.userId;
  const data = await updateExchange(String(req.params.id), req.body, actorId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function exchangeStatementController(req: Request, res: Response) {
  const query = exchangeStatementQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getExchangeStatement(String(req.params.id), query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}
