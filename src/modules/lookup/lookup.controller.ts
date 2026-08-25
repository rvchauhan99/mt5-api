import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { exchangeRateLookupQuerySchema, lookupQuerySchema } from "./lookup.validation";
import {
  getPlayerBonusProfileLookup,
  listBankLookupOptions,
  listExchangeLookupOptions,
  listExpenseTypeLookupOptions,
  listPlayerLookupOptions,
} from "./lookup.service";
import { resolveMasterExchangeRate } from "./exchange-rate-lookup.service";

export async function listBankLookupController(req: Request, res: Response) {
  const query = lookupQuerySchema.parse(req.query);
  const data = await listBankLookupOptions(query);
  res.setHeader("Cache-Control", "private, max-age=30");
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listExpenseTypeLookupController(req: Request, res: Response) {
  const query = lookupQuerySchema.parse(req.query);
  const data = await listExpenseTypeLookupOptions(query);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listPlayerLookupController(req: Request, res: Response) {
  const query = lookupQuerySchema.parse(req.query);
  const data = await listPlayerLookupOptions(query);
  res.setHeader("Cache-Control", "private, max-age=15");
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listExchangeLookupController(req: Request, res: Response) {
  const query = lookupQuerySchema.parse(req.query);
  const data = await listExchangeLookupOptions(query);
  res.setHeader("Cache-Control", "private, max-age=30");
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function getPlayerBonusProfileLookupController(req: Request, res: Response) {
  const playerId = String(req.params.id || "").trim();
  const data = await getPlayerBonusProfileLookup(playerId);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function getExchangeRateLookupController(req: Request, res: Response) {
  const query = exchangeRateLookupQuerySchema.parse(req.query);
  const data = await resolveMasterExchangeRate(query.from, query.to);
  res.setHeader("Cache-Control", "private, max-age=30");
  res.status(StatusCodes.OK).json({ success: true, data });
}
