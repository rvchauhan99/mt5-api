import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { listReferralAccruals, settleReferralAccruals, updateReferralAccrual } from "./referral.service";
import {
  listReferralAccrualQuerySchema,
  settleReferralAccrualBodySchema,
  updateReferralAccrualBodySchema,
} from "./referral.validation";

export async function listReferralAccrualController(req: Request, res: Response) {
  const query = listReferralAccrualQuerySchema.parse(req.query);
  const result = await listReferralAccruals(query);
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function settleReferralAccrualController(req: Request, res: Response) {
  const body = settleReferralAccrualBodySchema.parse(req.body);
  const result = await settleReferralAccruals(body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data: result });
}

export async function updateReferralAccrualController(req: Request, res: Response) {
  const body = updateReferralAccrualBodySchema.parse(req.body);
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await updateReferralAccrual(id, body, req.user!.userId, req.requestId);
  res.status(StatusCodes.OK).json({ success: true, data: result });
}
