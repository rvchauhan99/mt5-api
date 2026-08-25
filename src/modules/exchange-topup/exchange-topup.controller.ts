import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { createExchangeTopup, exportExchangeTopupsToBuffer, listExchangeTopups } from "./exchange-topup.service";
import { createExchangeTopupBodySchema, listExchangeTopupQuerySchema } from "./exchange-topup.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function createExchangeTopupController(req: Request, res: Response) {
  const body = createExchangeTopupBodySchema.parse(req.body);
  const data = await createExchangeTopup(body, req.user!.userId, req.requestId);
  res.status(StatusCodes.CREATED).json({ success: true, data });
}

export async function listExchangeTopupController(req: Request, res: Response) {
  const query = listExchangeTopupQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await listExchangeTopups(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: data.rows, meta: data.meta });
}

export async function exportExchangeTopupController(req: Request, res: Response) {
  const query = listExchangeTopupQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportExchangeTopupsToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="exchange-topups-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}
