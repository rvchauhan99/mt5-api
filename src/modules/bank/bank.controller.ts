import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import {
  createBank,
  createBankSettlement,
  exportBanksToBuffer,
  getBankComputedClosingBalance,
  getBankLedger,
  listBankSettlements,
  listBanks,
} from "./bank.service";
import {
  bankIdParamSchema,
  bankLedgerQuerySchema,
  createBankSettlementBodySchema,
  listBankQuerySchema,
} from "./bank.validation";
import { resolveRequestTimeZone } from "../../shared/utils/requestTimezone";

export async function createBankController(req: Request, res: Response) {
  const { doc, created } = await createBank(req.body, req.user!.userId, req.requestId);
  res.status(created ? StatusCodes.CREATED : StatusCodes.OK).json({
    success: true,
    data: doc,
    meta: created ? { created: true } : { created: false, updated: true },
  });
}

export async function listBankController(req: Request, res: Response) {
  const query = listBankQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const result = await listBanks(query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data: result.rows, meta: result.meta });
}

export async function exportBankController(req: Request, res: Response) {
  const query = listBankQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const buffer = await exportBanksToBuffer(query, { timeZone });
  res.setHeader("Content-Disposition", 'attachment; filename="banks-export.xlsx"');
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.status(StatusCodes.OK).send(buffer);
}

export async function bankLedgerController(req: Request, res: Response) {
  const { id } = bankIdParamSchema.parse(req.params);
  const query = bankLedgerQuerySchema.parse(req.query);
  const timeZone = resolveRequestTimeZone(req);
  const data = await getBankLedger(id, query, { timeZone });
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function listBankSettlementsController(req: Request, res: Response) {
  const { id } = bankIdParamSchema.parse(req.params);
  const data = await listBankSettlements(id);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function getBankComputedClosingController(req: Request, res: Response) {
  const { id } = bankIdParamSchema.parse(req.params);
  const data = await getBankComputedClosingBalance(id);
  res.status(StatusCodes.OK).json({ success: true, data });
}

export async function createBankSettlementController(req: Request, res: Response) {
  const { id } = bankIdParamSchema.parse(req.params);
  const body = createBankSettlementBodySchema.parse(req.body);
  const data = await createBankSettlement(
    id,
    {
      effectiveAt: body.effectiveAt,
      masterReportedBalance: body.masterReportedBalance,
      reason: body.reason,
    },
    req.user!.userId,
    req.requestId,
  );
  res.status(StatusCodes.CREATED).json({ success: true, data });
}
