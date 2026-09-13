import { Types } from "mongoose";
import type { z } from "zod";
import { generateMultiSheetExcelBuffer } from "../../shared/services/excel.service";
import { AppError } from "../../shared/errors/AppError";
import {
  DEFAULT_TIMEZONE,
  ymdToUtcEnd as ymdToUtcEndInZone,
  ymdToUtcStart as ymdToUtcStartInZone,
} from "../../shared/utils/timezone";
import { BankModel } from "../bank/bank.model";
import { bankDisplayName } from "../bank/bank.constants";
import { ExpenseModel } from "../expense/expense.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import type { balanceSheetMovementsQuerySchema } from "./balance-sheet.validation";

type MovementsQuery = z.infer<typeof balanceSheetMovementsQuerySchema>;

export interface BalanceSheetMovementRow {
  id: string;
  date: string | Date | null;
  type: string;
  status: string;
  amount: number;
  counterparty: string;
  bank: string;
  reference: string;
  description: string;
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function businessDateRangeExpr(
  field: "entryAt" | "requestedAt",
  startUtc: Date,
  endUtc: Date,
) {
  const txExpr = { $ifNull: [`$${field}`, "$createdAt"] };
  return {
    $expr: {
      $and: [{ $gte: [txExpr, startUtc] }, { $lte: [txExpr, endUtc] }],
    },
  };
}

function liabilityDateRangeExpr(startUtc: Date, endUtc: Date) {
  const txExpr = { $ifNull: ["$entryDate", "$createdAt"] };
  return {
    $expr: {
      $and: [{ $gte: [txExpr, startUtc] }, { $lte: [txExpr, endUtc] }],
    },
  };
}

async function resolveBankNames(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const banks = await BankModel.find({ _id: { $in: ids } })
    .select({ method: 1, holderName: 1, bankName: 1, accountNumber: 1 })
    .lean();
  const map = new Map<string, string>();
  for (const b of banks) {
    map.set(String(b._id), bankDisplayName(b));
  }
  return map;
}

async function resolvePersonNames(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const people = await LiabilityPersonModel.find({ _id: { $in: ids } })
    .select({ name: 1 })
    .lean();
  const map = new Map<string, string>();
  for (const p of people) {
    map.set(String(p._id), String(p.name ?? ""));
  }
  return map;
}

async function scopedPlayerIds(exchangeObjectId: Types.ObjectId | null): Promise<Types.ObjectId[] | null> {
  if (!exchangeObjectId) return null;
  const { PlayerModel } = await import("../player/player.model");
  return PlayerModel.distinct("_id", {
    exchange: exchangeObjectId,
    isMigratedOldUser: false,
  });
}

async function listDeposits(
  query: MovementsQuery,
  fromUtc: Date,
  toUtc: Date,
  exchangeObjectId: Types.ObjectId | null,
): Promise<{ rows: BalanceSheetMovementRow[]; total: number }> {
  const { DepositModel } = await import("../deposit/deposit.model");
  const skip = (query.page - 1) * query.pageSize;
  const playerIds = await scopedPlayerIds(exchangeObjectId);

  const statuses =
    query.status && query.status.trim()
      ? query.status.split(",").map((s) => s.trim()).filter(Boolean)
      : ["verified", "finalized"];

  const match: Record<string, unknown> = {
    status: { $in: statuses },
    ...businessDateRangeExpr("entryAt", fromUtc, toUtc),
  };
  if (query.bankId && Types.ObjectId.isValid(query.bankId)) {
    match.bankId = new Types.ObjectId(query.bankId);
  }
  if (playerIds) match.player = { $in: playerIds };
  if (query.search?.trim()) {
    const q = query.search.trim();
    match.$or = [{ utr: { $regex: q, $options: "i" } }];
  }

  const [docs, total] = await Promise.all([
    DepositModel.find(match)
      .sort({ entryAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(query.pageSize)
      .populate("player", "playerId")
      .lean(),
    DepositModel.countDocuments(match),
  ]);

  const bankIds = docs
    .map((d) => d.bankId)
    .filter((id): id is Types.ObjectId => Boolean(id) && Types.ObjectId.isValid(String(id)));
  const bankNames = await resolveBankNames(bankIds);

  const rows: BalanceSheetMovementRow[] = docs.map((d) => {
    const player = d.player as { playerId?: string } | null;
    return {
      id: String(d._id),
      date: d.entryAt ?? d.createdAt ?? null,
      type: "deposit",
      status: String(d.status ?? ""),
      amount: asNumber(d.amount),
      counterparty: player?.playerId || "",
      bank: d.bankId ? bankNames.get(String(d.bankId)) ?? "" : "",
      reference: String(d.utr ?? ""),
      description: "",
    };
  });

  return { rows, total };
}

async function listWithdrawals(
  query: MovementsQuery,
  fromUtc: Date,
  toUtc: Date,
  exchangeObjectId: Types.ObjectId | null,
): Promise<{ rows: BalanceSheetMovementRow[]; total: number }> {
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
  const skip = (query.page - 1) * query.pageSize;
  const playerIds = await scopedPlayerIds(exchangeObjectId);

  const statuses =
    query.status && query.status.trim()
      ? query.status.split(",").map((s) => s.trim()).filter(Boolean)
      : ["approved", "finalized"];

  const match: Record<string, unknown> = {
    status: { $in: statuses },
    ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
  };
  if (query.bankId && Types.ObjectId.isValid(query.bankId)) {
    match.payoutBankId = new Types.ObjectId(query.bankId);
  }
  if (playerIds) match.player = { $in: playerIds };
  if (query.search?.trim()) {
    const q = query.search.trim();
    match.$or = [{ utr: { $regex: q, $options: "i" } }];
  }

  const [docs, total] = await Promise.all([
    WithdrawalModel.find(match)
      .sort({ requestedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(query.pageSize)
      .populate("player", "playerId")
      .lean(),
    WithdrawalModel.countDocuments(match),
  ]);

  const bankIds = docs
    .map((d) => d.payoutBankId)
    .filter((id): id is Types.ObjectId => Boolean(id) && Types.ObjectId.isValid(String(id)));
  const bankNames = await resolveBankNames(bankIds);

  const rows: BalanceSheetMovementRow[] = docs.map((d) => {
    const player = d.player as { playerId?: string } | null;
    return {
      id: String(d._id),
      date: d.requestedAt ?? d.createdAt ?? null,
      type: "withdrawal",
      status: String(d.status ?? ""),
      amount: asNumber(d.payableAmount ?? d.amount),
      counterparty: player?.playerId || "",
      bank: d.payoutBankId ? bankNames.get(String(d.payoutBankId)) ?? "" : "",
      reference: String(d.utr ?? ""),
      description: "",
    };
  });

  return { rows, total };
}

async function listExpenses(
  query: MovementsQuery,
  fromUtc: Date,
  toUtc: Date,
): Promise<{ rows: BalanceSheetMovementRow[]; total: number }> {
  const skip = (query.page - 1) * query.pageSize;
  const statuses =
    query.status && query.status.trim()
      ? query.status.split(",").map((s) => s.trim()).filter(Boolean)
      : ["approved", "pending_audit"];

  const match: Record<string, unknown> = {
    status: { $in: statuses },
    expenseDate: { $gte: fromUtc, $lte: toUtc },
  };
  if (query.bankId && Types.ObjectId.isValid(query.bankId)) {
    match.bankId = new Types.ObjectId(query.bankId);
  }
  if (query.personId && Types.ObjectId.isValid(query.personId)) {
    match.liabilityPersonId = new Types.ObjectId(query.personId);
  }
  if (query.search?.trim()) {
    const q = query.search.trim();
    match.$or = [{ description: { $regex: q, $options: "i" } }];
  }

  const [docs, total] = await Promise.all([
    ExpenseModel.find(match)
      .sort({ expenseDate: -1 })
      .skip(skip)
      .limit(query.pageSize)
      .lean(),
    ExpenseModel.countDocuments(match),
  ]);

  const bankIds = docs
    .map((d) => d.bankId)
    .filter((id): id is Types.ObjectId => Boolean(id) && Types.ObjectId.isValid(String(id)));
  const personIds = docs
    .map((d) => d.liabilityPersonId)
    .filter((id): id is Types.ObjectId => Boolean(id) && Types.ObjectId.isValid(String(id)));
  const [bankNames, personNames] = await Promise.all([
    resolveBankNames(bankIds),
    resolvePersonNames(personIds),
  ]);

  const rows: BalanceSheetMovementRow[] = docs.map((d) => ({
    id: String(d._id),
    date: d.expenseDate ?? null,
    type: "expense",
    status: String(d.status ?? ""),
    amount: asNumber(d.amount),
    counterparty: d.liabilityPersonId
      ? personNames.get(String(d.liabilityPersonId)) ?? ""
      : "",
    bank: d.bankId ? bankNames.get(String(d.bankId)) ?? "" : "",
    reference: d.expenseTypeId ? String(d.expenseTypeId) : "",
    description: String(d.description ?? ""),
  }));

  return { rows, total };
}

async function listLiabilityEntries(
  query: MovementsQuery,
  fromUtc: Date,
  toUtc: Date,
  transfersOnly: boolean,
): Promise<{ rows: BalanceSheetMovementRow[]; total: number }> {
  const skip = (query.page - 1) * query.pageSize;
  const andClauses: Record<string, unknown>[] = [liabilityDateRangeExpr(fromUtc, toUtc)];

  if (transfersOnly) {
    andClauses.push({
      $or: [
        { entryType: "contra" },
        { fromAccountType: "bank", toAccountType: "bank" },
        { fromAccountType: "bank", toAccountType: "person" },
        { fromAccountType: "person", toAccountType: "bank" },
      ],
    });
  }

  if (query.bankId && Types.ObjectId.isValid(query.bankId)) {
    const bankId = new Types.ObjectId(query.bankId);
    andClauses.push({
      $or: [
        { fromAccountType: "bank", fromAccountId: bankId },
        { toAccountType: "bank", toAccountId: bankId },
      ],
    });
  }
  if (query.personId && Types.ObjectId.isValid(query.personId)) {
    const personId = new Types.ObjectId(query.personId);
    andClauses.push({
      $or: [
        { fromAccountType: "person", fromAccountId: personId },
        { toAccountType: "person", toAccountId: personId },
      ],
    });
  }
  if (query.status?.trim()) {
    andClauses.push({ entryType: query.status.trim() });
  }
  if (query.search?.trim()) {
    const q = query.search.trim();
    andClauses.push({
      $or: [
        { remark: { $regex: q, $options: "i" } },
        { referenceNo: { $regex: q, $options: "i" } },
      ],
    });
  }

  const match = andClauses.length === 1 ? andClauses[0]! : { $and: andClauses };

  const [docs, total] = await Promise.all([
    LiabilityEntryModel.find(match)
      .sort({ entryDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(query.pageSize)
      .lean(),
    LiabilityEntryModel.countDocuments(match),
  ]);

  const accountIds: Types.ObjectId[] = [];
  for (const d of docs) {
    if (Types.ObjectId.isValid(String(d.fromAccountId))) accountIds.push(d.fromAccountId);
    if (Types.ObjectId.isValid(String(d.toAccountId))) accountIds.push(d.toAccountId);
  }
  const uniqueIds = [...new Map(accountIds.map((id) => [String(id), id])).values()];
  const [bankNames, personNames] = await Promise.all([
    resolveBankNames(uniqueIds),
    resolvePersonNames(uniqueIds),
  ]);

  const label = (type: string, id: Types.ObjectId) => {
    if (type === "bank") return bankNames.get(String(id)) || `Bank ${String(id).slice(-6)}`;
    if (type === "person") return personNames.get(String(id)) || `Person ${String(id).slice(-6)}`;
    return `${type}:${String(id).slice(-6)}`;
  };

  const rows: BalanceSheetMovementRow[] = docs.map((d) => ({
    id: String(d._id),
    date: d.entryDate ?? d.createdAt ?? null,
    type: transfersOnly ? "transfer" : "liability",
    status: String(d.entryType ?? ""),
    amount: asNumber(d.amount),
    counterparty: `${label(d.fromAccountType, d.fromAccountId)} → ${label(d.toAccountType, d.toAccountId)}`,
    bank:
      d.fromAccountType === "bank"
        ? label("bank", d.fromAccountId)
        : d.toAccountType === "bank"
          ? label("bank", d.toAccountId)
          : "",
    reference: String(d.referenceNo ?? ""),
    description: String(d.remark ?? d.sourceType ?? ""),
  }));

  return { rows, total };
}

export async function getBalanceSheetMovements(
  query: MovementsQuery,
  options?: { timeZone?: string },
): Promise<{ rows: BalanceSheetMovementRow[]; meta: { page: number; pageSize: number; total: number } }> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  if (query.fromDate > query.toDate) {
    throw new AppError("VALIDATION_ERROR", "fromDate must be on or before toDate", 400);
  }
  const fromUtc = ymdToUtcStartInZone(query.fromDate, timeZone);
  const toUtc = ymdToUtcEndInZone(query.toDate, timeZone);
  if (!fromUtc || !toUtc) {
    throw new AppError("VALIDATION_ERROR", "Invalid date range", 400);
  }

  const exchangeObjectId =
    query.exchangeId && Types.ObjectId.isValid(query.exchangeId)
      ? new Types.ObjectId(query.exchangeId)
      : null;

  let result: { rows: BalanceSheetMovementRow[]; total: number };
  switch (query.type) {
    case "deposit":
      result = await listDeposits(query, fromUtc, toUtc, exchangeObjectId);
      break;
    case "withdrawal":
      result = await listWithdrawals(query, fromUtc, toUtc, exchangeObjectId);
      break;
    case "expense":
      result = await listExpenses(query, fromUtc, toUtc);
      break;
    case "liability":
      result = await listLiabilityEntries(query, fromUtc, toUtc, false);
      break;
    case "transfer":
      result = await listLiabilityEntries(query, fromUtc, toUtc, true);
      break;
    default:
      throw new AppError("VALIDATION_ERROR", "Invalid movement type", 400);
  }

  return {
    rows: result.rows,
    meta: { page: query.page, pageSize: query.pageSize, total: result.total },
  };
}

export async function exportBalanceSheetMovementsToBuffer(
  query: MovementsQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const exportQuery = { ...query, page: 1, pageSize: 5000 };
  const data = await getBalanceSheetMovements(exportQuery, options);
  const sheet = data.rows.map((r) => ({
    Date: r.date ? new Date(r.date).toISOString() : "",
    Type: r.type,
    Status: r.status,
    Amount: r.amount,
    Counterparty: r.counterparty,
    Bank: r.bank,
    Reference: r.reference,
    Description: r.description,
  }));

  return generateMultiSheetExcelBuffer([
    {
      name: "Movements",
      data: sheet,
      columns: [
        { header: "Date", key: "Date" },
        { header: "Type", key: "Type" },
        { header: "Status", key: "Status" },
        { header: "Amount", key: "Amount" },
        { header: "Counterparty", key: "Counterparty" },
        { header: "Bank", key: "Bank" },
        { header: "Reference", key: "Reference" },
        { header: "Description", key: "Description" },
      ],
    },
  ]);
}
