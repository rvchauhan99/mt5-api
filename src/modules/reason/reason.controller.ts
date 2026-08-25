import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import type { ReasonType } from "../../shared/constants/reasonTypes";
import { listActiveReasonOptions } from "./reason.service";
import { listReasonOptionsQuerySchema } from "./reason.validation";

export async function listReasonOptionsController(req: Request, res: Response) {
  const query = listReasonOptionsQuerySchema.parse(req.query);
  const data = await listActiveReasonOptions(query.reasonType as ReasonType, query.limit);
  res.status(StatusCodes.OK).json({ success: true, data });
}
