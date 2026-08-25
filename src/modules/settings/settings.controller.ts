import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { getPlatformSettings, setPlatformCurrency } from "./settings.service";

export async function getPlatformSettingsController(_req: Request, res: Response) {
  const data = await getPlatformSettings();
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function setPlatformCurrencyController(req: Request, res: Response) {
  const { currency } = req.body as { currency: Parameters<typeof setPlatformCurrency>[0] };
  const userId = req.user!.userId;
  const data = await setPlatformCurrency(currency, userId);
  res.status(StatusCodes.OK).json({ success: true, data });
}
