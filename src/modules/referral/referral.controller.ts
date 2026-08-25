import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { listReferralAccruals, settleReferralAccruals } from "./referral.service";
import { listReferralAccrualQuerySchema, settleReferralAccrualBodySchema } from "./referral.validation";

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
