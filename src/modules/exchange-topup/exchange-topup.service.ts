import { Types } from "mongoose";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { ExchangeModel } from "../exchange/exchange.model";
import { recomputeExchangeCurrentBalance } from "../exchange/exchange.service";
import { DEFAULT_TIMEZONE, formatDateTimeForTimeZone } from "../../shared/utils/timezone";
import { ExchangeTopupModel } from "./exchange-topup.model";
import { exportExchangeTopupQuerySchema } from "./exchange-topup.validation";
import { resolveMoneyFromRequest } from "../../shared/utils/moneyFx";
import type { z } from "zod";

type ExportExchangeTopupQuery = z.infer<typeof exportExchangeTopupQuerySchema>;
import { getCurrencyMinUnit } from "../../shared/constants/currencies";
import { requirePlatformCurrency } from "../settings/settings.service";

export async function createExchangeTopup(
  input: {
    exchangeId: string;
    amount: number;
    remark?: string;
    operatedCurrency?: string;
    operatedAmount?: number;
    exchangeRate?: number;
  },
  actorId: string,
  requestId?: string,
) {
  if (!Types.ObjectId.isValid(input.exchangeId)) {
    throw new AppError("validation_error", "Invalid exchange id", 400);
  }
  const exchangeObjectId = new Types.ObjectId(input.exchangeId);
  const exchange = await ExchangeModel.findById(exchangeObjectId).select("_id name provider");
  if (!exchange) throw new AppError("not_found", "Exchange not found", 404);

  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: getCurrencyMinUnit(await requirePlatformCurrency()) },
  );

  const doc = await ExchangeTopupModel.create({
    exchangeId: exchangeObjectId,
    amount: money.amount,
    operatedCurrency: money.operatedCurrency,
    operatedAmount: money.operatedAmount,
    exchangeRate: money.exchangeRate,
    remark: input.remark?.trim() || undefined,
    createdBy: new Types.ObjectId(actorId),
  });

  const currentBalance = await recomputeExchangeCurrentBalance(exchangeObjectId.toString());

  await createAuditLog({
    actorId,
    action: "exchange.topup_create",
    entity: "exchange_topup",
    entityId: doc._id.toString(),
    newValue: {
      exchangeId: exchangeObjectId.toString(),
      amount: doc.amount,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
      remark: doc.remark,
      currentBalance,
    },
    requestId,
  });

  return {
    ...doc.toObject(),
    currentBalance,
  };
}

export async function listExchangeTopups(query: {
  exchangeId?: string;
  page: number;
  pageSize: number;
  sortOrder: "asc" | "desc";
}, _options?: { timeZone?: string }) {
  const filter: Record<string, unknown> = {};
  if (query.exchangeId) {
    if (!Types.ObjectId.isValid(query.exchangeId)) {
      throw new AppError("validation_error", "Invalid exchange id", 400);
    }
    filter.exchangeId = new Types.ObjectId(query.exchangeId);
  }

  const skip = (query.page - 1) * query.pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    ExchangeTopupModel.find(filter)
      .populate("exchangeId", "name provider currentBalance openingBalance")
      .populate("createdBy", "fullName username")
      .sort({ createdAt: sortValue })
      .skip(skip)
      .limit(query.pageSize)
      .lean(),
    ExchangeTopupModel.countDocuments(filter),
  ]);

  return {
    rows,
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total,
    },
  };
}

const EXPORT_MAX_ROWS = 10_000;

export async function exportExchangeTopupsToBuffer(
  query: ExportExchangeTopupQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const result = await listExchangeTopups({
    ...query,
    page: 1,
    pageSize: EXPORT_MAX_ROWS,
  }, options);

  const exportData = result.rows.map((r) => {
    const exchange = r.exchangeId as { name?: string; provider?: string } | null;
    const author = r.createdBy as { fullName?: string; username?: string } | null;

    let authorName = author?.fullName || author?.username || "";
    if (author?.fullName && author?.username) {
      authorName = `${author.fullName} (${author.username})`;
    }

    return {
      Date: formatDateTimeForTimeZone(r.createdAt, timeZone),
      Exchange: exchange?.name || "",
      Provider: exchange?.provider || "",
      Amount: r.amount,
      Remark: r.remark || "",
      "Created By": authorName,
    };
  });

  return generateExcelBuffer(exportData, "Exchange Topups");
}
