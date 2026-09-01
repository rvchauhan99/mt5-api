import { BankModel } from "../bank/bank.model";
import { ExchangeModel } from "../exchange/exchange.model";
import { PlayerModel } from "../player/player.model";
import { ExpenseTypeModel } from "../masters/expense-type.model";
import { PaymentMethodModel } from "../masters/payment-method.model";
import { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import { getCachedJson, getCacheVersion, setCachedJson } from "../../shared/cache/cache.service";
import { bankDisplayName, toMethodCode } from "../bank/bank.constants";

export type LookupQueryParams = {
  q?: string;
  limit: number;
  id?: string;
  userType?: "trader" | "ib";
};

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableLookupKey(prefix: string, payload: Record<string, unknown>, version: number): string {
  return `v${version}:lookup:${prefix}:${JSON.stringify(payload)}`;
}

export async function listBankLookupOptions({ q, limit }: LookupQueryParams) {
  const version = await getCacheVersion("bank");
  const cacheKey = stableLookupKey("bank-v4", { q: q ?? "", limit }, version);
  const cached = await getCachedJson<any[]>(cacheKey);
  if (cached) return cached;
  const qTrim = q?.trim();
  const filter: Record<string, unknown> = { status: "active" };
  if (qTrim) {
    const esc = escapeRegex(qTrim);
    filter.$or = [
      { holderName: { $regex: esc, $options: "i" } },
      { bankName: { $regex: esc, $options: "i" } },
      { accountNumber: { $regex: esc, $options: "i" } },
      { ifsc: { $regex: esc, $options: "i" } },
      { method: { $regex: esc, $options: "i" } },
    ];
  }
  const rows = await BankModel.find(filter)
    .sort({ holderName: 1, bankName: 1 })
    .limit(limit)
    .select({ method: 1, holderName: 1, bankName: 1, accountNumber: 1 })
    .lean()
    .exec();
  const methodCodes = [...new Set(rows.map((row) => toMethodCode(String(row.method ?? ""))).filter(Boolean))];
  const methodRows = methodCodes.length
    ? await PaymentMethodModel.find({
        code: { $in: methodCodes },
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      })
        .select({ code: 1, isActive: 1, isActiveForWithdrawalPayout: 1, isActiveForDeposit: 1 })
        .lean()
        .exec()
    : [];
  const methodConfigByCode = new Map(
    methodRows.map((row) => [
      String(row.code ?? "").trim(),
      {
        isActive: row.isActive !== false,
        isActiveForWithdrawalPayout: row.isActiveForWithdrawalPayout !== false,
        isActiveForDeposit: row.isActiveForDeposit !== false,
      },
    ]),
  );
  const data = rows.map((row) => ({
    ...(methodConfigByCode.get(toMethodCode(String(row.method ?? ""))) ?? {
      isActive: true,
      isActiveForWithdrawalPayout: true,
      isActiveForDeposit: true,
    }),
    id: String(row._id),
    label: bankDisplayName(row),
    method: row.method != null ? String(row.method) : undefined,
    holderName: String(row.holderName ?? ""),
    bankName: String(row.bankName ?? ""),
    accountNumber: String(row.accountNumber ?? ""),
  }));
  await setCachedJson(cacheKey, data, 60 * 10);
  return data;
}

type ExpenseTypeLookupLean = {
  _id: unknown;
  name?: unknown;
  code?: unknown;
  description?: unknown;
  auditRequired?: boolean;
};

function mapExpenseTypeLookupRow(row: ExpenseTypeLookupLean) {
  const ar = row.auditRequired;
  const requiresAudit = ar !== false;
  return {
    id: String(row._id),
    label: String(row.name ?? ""),
    name: String(row.name ?? ""),
    code: row.code != null ? String(row.code) : undefined,
    description: row.description != null ? String(row.description) : undefined,
    requiresAudit,
    auditNotRequired: ar === false,
  };
}

export async function listExpenseTypeLookupOptions({ q, limit, id }: LookupQueryParams) {
  const version = await getCacheVersion("expenseType");
  const idTrim = id?.trim();
  if (idTrim && Types.ObjectId.isValid(idTrim)) {
    const row = await ExpenseTypeModel.findOne({
      _id: new Types.ObjectId(idTrim),
      isActive: true,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select({ name: 1, code: 1, description: 1, auditRequired: 1 })
      .lean()
      .exec();
    if (!row) return [];
    return [mapExpenseTypeLookupRow(row as ExpenseTypeLookupLean)];
  }

  const cacheKey = stableLookupKey("expenseType", { q: q ?? "", id: "", limit }, version);
  const cached = await getCachedJson<any[]>(cacheKey);
  if (cached) return cached;

  const qTrim = q?.trim();
  const filter: Record<string, unknown> = {
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  if (qTrim) {
    const esc = escapeRegex(qTrim);
    filter.$and = [
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      {
        $or: [
          { name: { $regex: esc, $options: "i" } },
          { code: { $regex: esc, $options: "i" } },
          { description: { $regex: esc, $options: "i" } },
        ],
      },
    ];
    delete filter.$or;
  }
  const rows = await ExpenseTypeModel.find(filter)
    .sort({ name: 1 })
    .limit(limit)
    .select({ name: 1, code: 1, description: 1, auditRequired: 1 })
    .lean()
    .exec();
  const data = rows.map((row) => mapExpenseTypeLookupRow(row as ExpenseTypeLookupLean));
  await setCachedJson(cacheKey, data, 60 * 10);
  return data;
}

type PaymentMethodLookupLean = {
  _id: unknown;
  name?: unknown;
  code?: unknown;
  description?: unknown;
  isActiveForWithdrawalPayout?: boolean;
  isActiveForDeposit?: boolean;
};

function mapPaymentMethodLookupRow(row: PaymentMethodLookupLean) {
  const name = String(row.name ?? "").trim();
  const code = row.code != null && String(row.code).trim() !== "" ? String(row.code).trim() : toMethodCode(name);
  return {
    id: String(row._id),
    label: name || code,
    name,
    code,
    description: row.description != null ? String(row.description) : undefined,
    isActiveForWithdrawalPayout: row.isActiveForWithdrawalPayout !== false,
    isActiveForDeposit: row.isActiveForDeposit !== false,
  };
}

export async function listPaymentMethodLookupOptions({ q, limit, id }: LookupQueryParams) {
  const version = await getCacheVersion("paymentMethod");
  const idTrim = id?.trim();
  if (idTrim && Types.ObjectId.isValid(idTrim)) {
    const row = await PaymentMethodModel.findOne({
      _id: new Types.ObjectId(idTrim),
      isActive: true,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    })
      .select({ name: 1, code: 1, description: 1, isActiveForWithdrawalPayout: 1, isActiveForDeposit: 1 })
      .lean()
      .exec();
    if (!row) return [];
    return [mapPaymentMethodLookupRow(row as PaymentMethodLookupLean)];
  }

  const cacheKey = stableLookupKey("paymentMethod", { q: q ?? "", id: "", limit }, version);
  const cached = await getCachedJson<ReturnType<typeof mapPaymentMethodLookupRow>[]>(cacheKey);
  if (cached) return cached;

  const qTrim = q?.trim();
  const filter: Record<string, unknown> = {
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  if (qTrim) {
    const esc = escapeRegex(qTrim);
    filter.$and = [
      { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
      {
        $or: [
          { name: { $regex: esc, $options: "i" } },
          { code: { $regex: esc, $options: "i" } },
          { description: { $regex: esc, $options: "i" } },
        ],
      },
    ];
    delete filter.$or;
  }
  const rows = await PaymentMethodModel.find(filter)
    .sort({ name: 1 })
    .limit(limit)
    .select({ name: 1, code: 1, description: 1, isActiveForWithdrawalPayout: 1, isActiveForDeposit: 1 })
    .lean()
    .exec();
  const data = rows.map((row) => mapPaymentMethodLookupRow(row as PaymentMethodLookupLean));
  await setCachedJson(cacheKey, data, 60 * 10);
  return data;
}

export async function listPlayerLookupOptions({ q, limit, userType }: LookupQueryParams) {
  const version = await getCacheVersion("player");
  const cacheKey = stableLookupKey("player", { q: q ?? "", limit, userType: userType ?? "" }, version);
  const cached = await getCachedJson<any[]>(cacheKey);
  if (cached) return cached;
  const qTrim = q?.trim();
  const filter: Record<string, unknown> = {};
  if (userType === "trader" || userType === "ib") {
    filter.userType = userType;
  }
  if (qTrim) {
    const esc = escapeRegex(qTrim);
    filter.$or = [
      { playerId: { $regex: esc, $options: "i" } },
      { phone: { $regex: esc, $options: "i" } },
    ];
  }
  const rows = await PlayerModel.find(filter)
    .populate("exchange", "name provider")
    .sort({ playerId: 1 })
    .limit(limit)
    .select({ playerId: 1, phone: 1, exchange: 1 })
    .lean()
    .exec();
  const data = rows.map((row) => {
    const exchange = row.exchange as { _id?: unknown; name?: unknown; provider?: unknown } | undefined;
    const exchangeName = exchange?.name != null ? String(exchange.name) : "";
    const exchangeProvider = exchange?.provider != null ? String(exchange.provider) : "";
    const exchangeLabel = `${exchangeName}${exchangeProvider ? ` (${exchangeProvider})` : ""}`.trim();
    return {
      id: String(row._id),
      label: `${String(row.playerId ?? "")}${exchangeLabel ? ` - ${exchangeLabel}` : ""}`,
      playerId: String(row.playerId ?? ""),
      phone: String(row.phone ?? ""),
      exchangeId: exchange?._id != null ? String(exchange._id) : undefined,
      exchangeName,
      exchangeProvider,
    };
  });
  await setCachedJson(cacheKey, data, 60);
  return data;
}

export async function listExchangeLookupOptions({ q, limit }: LookupQueryParams) {
  const version = await getCacheVersion("exchange");
  const cacheKey = stableLookupKey("exchange", { q: q ?? "", limit }, version);
  const cached = await getCachedJson<any[]>(cacheKey);
  if (cached) return cached;
  const qTrim = q?.trim();
  const filter: Record<string, unknown> = { status: "active" };
  if (qTrim) {
    const esc = escapeRegex(qTrim);
    filter.$or = [
      { name: { $regex: esc, $options: "i" } },
      { provider: { $regex: esc, $options: "i" } },
    ];
  }
  const rows = await ExchangeModel.find(filter)
    .sort({ name: 1, provider: 1 })
    .limit(limit)
    .select({ name: 1, provider: 1, status: 1 })
    .lean()
    .exec();
  const data = rows.map((row) => ({
    id: String(row._id),
    label: `${String(row.name ?? "")}${row.provider ? ` (${String(row.provider)})` : ""}`,
    name: String(row.name ?? ""),
    provider: String(row.provider ?? ""),
    status: String(row.status ?? ""),
  }));
  await setCachedJson(cacheKey, data, 60 * 5);
  return data;
}

export async function getPlayerBonusProfileLookup(playerId: string) {
  const id = String(playerId || "").trim();
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid player id", 400);
  }
  const row = await PlayerModel.findById(id)
    .select({ playerId: 1, regularBonusPercentage: 1, firstDepositBonusPercentage: 1 })
    .lean()
    .exec();
  if (!row) {
    throw new AppError("not_found", "Player not found", 404);
  }
  return {
    id: String(row._id),
    playerId: String(row.playerId ?? ""),
    regularBonusPercentage: Number(row.regularBonusPercentage ?? 0),
    firstDepositBonusPercentage: Number(row.firstDepositBonusPercentage ?? 0),
  };
}

