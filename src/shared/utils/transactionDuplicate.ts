import { Types } from "mongoose";
import { DepositModel } from "../../modules/deposit/deposit.model";
import { WithdrawalModel } from "../../modules/withdrawal/withdrawal.model";
import { AppError } from "../errors/AppError";
import { escapeRegex, normalizeUtr } from "./utr";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  normalizeTimeZone,
  ymdToUtcEnd,
  ymdToUtcStart,
} from "./timezone";

export const DUPLICATE_TRANSACTION_MESSAGE =
  "A duplicate transaction already exists (same trader, settlement account, amount, date, and reference number)";

export type TransactionSettlementType = "bank" | "person";

export type TransactionDuplicateInput = {
  playerId: Types.ObjectId | string;
  settlementType: TransactionSettlementType;
  settlementAccountId: Types.ObjectId | string;
  amount: number;
  transactionAt: Date;
  utr: string;
  timeZone?: string;
  excludeDepositId?: Types.ObjectId | string;
  excludeWithdrawalId?: Types.ObjectId | string;
};

export type DuplicateTransactionContext = {
  type: "deposit" | "withdrawal";
  id: string;
  status: string;
  dateTime: Date;
};

function toObjectId(value: Types.ObjectId | string): Types.ObjectId {
  if (value instanceof Types.ObjectId) return value;
  return new Types.ObjectId(String(value));
}

function businessDateExpr(field: string, fallbackField: string) {
  return { $ifNull: [`$${field}`, `$${fallbackField}`] };
}

export function buildTransactionDayRange(
  transactionAt: Date,
  timeZone?: string,
): { start: Date; end: Date; ymd: string } {
  const tz = normalizeTimeZone(timeZone, DEFAULT_TIMEZONE);
  const ymd = formatDateForTimeZone(transactionAt, tz);
  const start = ymdToUtcStart(ymd, tz);
  const end = ymdToUtcEnd(ymd, tz);
  if (!start || !end) {
    throw new AppError("validation_error", "Invalid transaction date for duplicate check", 400);
  }
  return { start, end, ymd };
}

export function buildTransactionDuplicateKey(input: TransactionDuplicateInput): string {
  const tz = normalizeTimeZone(input.timeZone, DEFAULT_TIMEZONE);
  const playerId = String(input.playerId);
  const accountId = String(input.settlementAccountId);
  const { ymd } = buildTransactionDayRange(input.transactionAt, tz);
  const utr = normalizeUtr(input.utr);
  const settlementKey =
    input.settlementType === "bank" ? `bank:${accountId}` : `person:${accountId}`;
  return `${playerId}|${settlementKey}|${input.amount}|${ymd}|${utr}`;
}

function depositSettlementMatch(input: TransactionDuplicateInput): Record<string, unknown> {
  const accountId = toObjectId(input.settlementAccountId);
  if (input.settlementType === "bank") {
    return { bankId: accountId };
  }
  return { liabilityPersonId: accountId };
}

function withdrawalSettlementMatch(input: TransactionDuplicateInput): Record<string, unknown> {
  const accountId = toObjectId(input.settlementAccountId);
  if (input.settlementType === "bank") {
    return { payoutBankId: accountId };
  }
  return { payoutLiabilityPersonId: accountId };
}

function businessDateRangeFilter(start: Date, end: Date, primaryField: string, fallbackField: string) {
  const expr = businessDateExpr(primaryField, fallbackField);
  return {
    $expr: {
      $and: [{ $gte: [expr, start] }, { $lte: [expr, end] }],
    },
  };
}

export async function findDuplicateTransaction(
  input: TransactionDuplicateInput,
): Promise<DuplicateTransactionContext | null> {
  const tz = normalizeTimeZone(input.timeZone, DEFAULT_TIMEZONE);
  const { start, end } = buildTransactionDayRange(input.transactionAt, tz);
  const playerId = toObjectId(input.playerId);
  const normalizedUtr = normalizeUtr(input.utr);
  const utrMatcher = { $regex: `^${escapeRegex(normalizedUtr)}$`, $options: "i" };

  const depositFilter: Record<string, unknown> = {
    status: { $ne: "rejected" },
    player: playerId,
    amount: input.amount,
    utr: utrMatcher,
    ...depositSettlementMatch(input),
    ...businessDateRangeFilter(start, end, "entryAt", "createdAt"),
  };
  if (input.excludeDepositId) {
    depositFilter._id = { $ne: toObjectId(input.excludeDepositId) };
  }

  const withdrawalFilter: Record<string, unknown> = {
    status: { $ne: "rejected" },
    player: playerId,
    amount: input.amount,
    utr: utrMatcher,
    ...withdrawalSettlementMatch(input),
    ...businessDateRangeFilter(start, end, "requestedAt", "createdAt"),
  };
  if (input.excludeWithdrawalId) {
    withdrawalFilter._id = { $ne: toObjectId(input.excludeWithdrawalId) };
  }

  const [depositConflict, withdrawalConflict] = await Promise.all([
    DepositModel.findOne(depositFilter)
      .select({ _id: 1, status: 1, entryAt: 1, createdAt: 1 })
      .lean(),
    WithdrawalModel.findOne(withdrawalFilter)
      .select({ _id: 1, status: 1, requestedAt: 1, createdAt: 1 })
      .lean(),
  ]);

  if (depositConflict) {
    return {
      type: "deposit",
      id: String(depositConflict._id),
      status: String(depositConflict.status ?? ""),
      dateTime: (depositConflict.entryAt as Date | undefined) ?? (depositConflict.createdAt as Date),
    };
  }
  if (withdrawalConflict) {
    return {
      type: "withdrawal",
      id: String(withdrawalConflict._id),
      status: String(withdrawalConflict.status ?? ""),
      dateTime:
        (withdrawalConflict.requestedAt as Date | undefined) ??
        (withdrawalConflict.createdAt as Date),
    };
  }
  return null;
}

export async function ensureNoDuplicateTransaction(input: TransactionDuplicateInput): Promise<void> {
  const duplicateTransaction = await findDuplicateTransaction(input);
  if (!duplicateTransaction) return;
  throw new AppError("business_rule_error", DUPLICATE_TRANSACTION_MESSAGE, 409, {
    duplicateTransaction,
  });
}
