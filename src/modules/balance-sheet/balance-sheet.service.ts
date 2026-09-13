import { Types } from "mongoose";
import type { z } from "zod";
import { generateMultiSheetExcelBuffer } from "../../shared/services/excel.service";
import { AppError } from "../../shared/errors/AppError";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  ymdToUtcEnd as ymdToUtcEndInZone,
  ymdToUtcStart as ymdToUtcStartInZone,
} from "../../shared/utils/timezone";
import { BankModel } from "../bank/bank.model";
import { BankBalanceSettlementModel } from "../bank/bank-balance-settlement.model";
import { bankDisplayName } from "../bank/bank.constants";
import { ExchangeModel } from "../exchange/exchange.model";
import { ExchangeTopupModel } from "../exchange-topup/exchange-topup.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { ExpenseModel } from "../expense/expense.model";
import { ReferralAccrualModel } from "../referral/referral-accrual.model";
import {
  BALANCE_SHEET_GROUP_CODES,
  BalanceSheetGroupModel,
  BalanceSheetSnapshotModel,
  type BalanceSheetLedgerSourceType,
  type BalanceSheetSide,
} from "./balance-sheet.model";
import type {
  balanceSheetDrilldownQuerySchema,
  balanceSheetQuerySchema,
  createBalanceSheetSnapshotBodySchema,
} from "./balance-sheet.validation";

type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
type BalanceSheetDrilldownQuery = z.infer<typeof balanceSheetDrilldownQuerySchema>;
type CreateBalanceSheetSnapshotBody = z.infer<typeof createBalanceSheetSnapshotBodySchema>;

export interface BalanceSheetLedger {
  ledgerId: string;
  name: string;
  type: BalanceSheetLedgerSourceType;
  openingBalance: number;
  periodDebits: number;
  periodCredits: number;
  closingBalance: number;
  side: BalanceSheetSide;
  groupCode: string;
  compareClosingBalance?: number | null;
  compareDelta?: number | null;
}

export interface BalanceSheetGroupNode {
  groupId: string;
  code: string;
  name: string;
  parentGroupId: string | null;
  parentCode: string | null;
  side: BalanceSheetSide;
  level: number;
  sortOrder: number;
  ledgers: BalanceSheetLedger[];
  subGroups: BalanceSheetGroupNode[];
  total: number;
  compareTotal?: number | null;
  compareDelta?: number | null;
}

export interface BalanceSheetResponse {
  meta: {
    fromDate: string;
    toDate: string;
    exchangeId: string | null;
    timeZone: string;
    currency: string;
    compare: string;
    compareFromDate: string | null;
    compareToDate: string | null;
    showZeroBalances: boolean;
    isBalanced: boolean;
    difference: number;
  };
  totals: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    grossPL: number;
    netPL: number;
    compareTotalAssets?: number | null;
    compareTotalLiabilities?: number | null;
    compareTotalEquity?: number | null;
  };
  assets: BalanceSheetGroupNode[];
  liabilities: BalanceSheetGroupNode[];
  equity: BalanceSheetGroupNode[];
}

const BALANCE_TOLERANCE = 0.01;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function liabilityDateBeforeExpr(beforeUtc: Date | null) {
  if (!beforeUtc) return {};
  const txExpr = { $ifNull: ["$entryDate", "$createdAt"] };
  return { $expr: { $lt: [txExpr, beforeUtc] } };
}

function liabilityDateRangeExpr(startUtc: Date | null, endUtc: Date | null) {
  if (!startUtc || !endUtc) return {};
  const txExpr = { $ifNull: ["$entryDate", "$createdAt"] };
  return {
    $expr: {
      $and: [{ $gte: [txExpr, startUtc] }, { $lte: [txExpr, endUtc] }],
    },
  };
}

function businessDateBeforeExpr(field: "entryAt" | "requestedAt", beforeUtc: Date | null) {
  if (!beforeUtc) return {};
  const txExpr = { $ifNull: [`$${field}`, "$createdAt"] };
  return { $expr: { $lt: [txExpr, beforeUtc] } };
}

function businessDateRangeExpr(
  field: "entryAt" | "requestedAt",
  startUtc: Date | null,
  endUtc: Date | null,
) {
  if (!startUtc || !endUtc) return {};
  const txExpr = { $ifNull: [`$${field}`, "$createdAt"] };
  return {
    $expr: {
      $and: [{ $gte: [txExpr, startUtc] }, { $lte: [txExpr, endUtc] }],
    },
  };
}

function resolveCompareRange(
  fromDate: string,
  toDate: string,
  compare: string,
  timeZone: string,
): { compareFromDate: string; compareToDate: string } | null {
  if (compare === "none" || !compare) return null;

  const fromUtc = ymdToUtcStartInZone(fromDate, timeZone);
  const toUtc = ymdToUtcStartInZone(toDate, timeZone);
  if (!fromUtc || !toUtc) return null;

  const periodMs = toUtc.getTime() - fromUtc.getTime() + 24 * 60 * 60 * 1000;

  if (compare === "prior_period") {
    const compareTo = new Date(fromUtc.getTime() - 24 * 60 * 60 * 1000);
    const compareFrom = new Date(compareTo.getTime() - periodMs + 24 * 60 * 60 * 1000);
    return {
      compareFromDate: formatDateForTimeZone(compareFrom, timeZone),
      compareToDate: formatDateForTimeZone(compareTo, timeZone),
    };
  }

  if (compare === "yoy") {
    const shiftYear = (ymd: string, delta: number) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return `${y! + delta}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    return {
      compareFromDate: shiftYear(fromDate, -1),
      compareToDate: shiftYear(toDate, -1),
    };
  }

  if (compare === "qoq") {
    const shiftMonths = (ymd: string, months: number) => {
      const [y, m, d] = ymd.split("-").map(Number);
      const dt = new Date(Date.UTC(y!, m! - 1, d!));
      dt.setUTCMonth(dt.getUTCMonth() + months);
      return formatDateForTimeZone(dt, timeZone);
    };
    return {
      compareFromDate: shiftMonths(fromDate, -3),
      compareToDate: shiftMonths(toDate, -3),
    };
  }

  return null;
}

type PeriodBounds = {
  fromUtc: Date;
  toUtc: Date;
  fromDate: string;
  toDate: string;
};

async function getBankLedgers(bounds: PeriodBounds): Promise<BalanceSheetLedger[]> {
  const { fromUtc, toUtc } = bounds;
  const banks = await BankModel.find({ status: "active" })
    .select({ _id: 1, method: 1, holderName: 1, bankName: 1, accountNumber: 1, openingBalance: 1 })
    .lean();
  if (banks.length === 0) return [];

  const bankIds = banks.map((b) => b._id);

  const [
    depositBefore,
    depositIn,
    withdrawalBefore,
    withdrawalIn,
    expenseBefore,
    expenseIn,
    transferOutBefore,
    transferOutIn,
    transferInBefore,
    transferInIn,
    settlementBefore,
    settlementIn,
    referralBefore,
    referralIn,
  ] = await Promise.all([
    DepositAggByBank({ bankIds, ...businessDateBeforeExpr("entryAt", fromUtc), status: { $in: ["verified", "finalized"] } }),
    DepositAggByBank({ bankIds, ...businessDateRangeExpr("entryAt", fromUtc, toUtc), status: { $in: ["verified", "finalized"] } }),
    WithdrawalAggByBank({
      bankIds,
      ...businessDateBeforeExpr("requestedAt", fromUtc),
      status: { $in: ["approved", "finalized"] },
    }),
    WithdrawalAggByBank({
      bankIds,
      ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
      status: { $in: ["approved", "finalized"] },
    }),
    ExpenseAggByBank({
      bankIds,
      expenseDate: { $lt: fromUtc },
      status: "approved",
      settlementAccountType: "bank",
    }),
    ExpenseAggByBank({
      bankIds,
      expenseDate: { $gte: fromUtc, $lte: toUtc },
      status: "approved",
      settlementAccountType: "bank",
    }),
    LiabilityAggByBank({ bankIds, direction: "out", ...liabilityDateBeforeExpr(fromUtc) }),
    LiabilityAggByBank({ bankIds, direction: "out", ...liabilityDateRangeExpr(fromUtc, toUtc) }),
    LiabilityAggByBank({ bankIds, direction: "in", ...liabilityDateBeforeExpr(fromUtc) }),
    LiabilityAggByBank({ bankIds, direction: "in", ...liabilityDateRangeExpr(fromUtc, toUtc) }),
    SettlementAggByBank({ bankIds, effectiveAt: { $lt: fromUtc } }),
    SettlementAggByBank({ bankIds, effectiveAt: { $gte: fromUtc, $lte: toUtc } }),
    ReferralAggByBank({ bankIds, createdAt: { $lt: fromUtc } }),
    ReferralAggByBank({ bankIds, createdAt: { $gte: fromUtc, $lte: toUtc } }),
  ]);

  const toMap = (rows: Array<{ _id?: unknown; totalAmount?: number }>) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const id = String(row._id ?? "");
      if (!Types.ObjectId.isValid(id)) continue;
      map.set(id, asNumber(row.totalAmount));
    }
    return map;
  };

  const depB = toMap(depositBefore);
  const depI = toMap(depositIn);
  const wthB = toMap(withdrawalBefore);
  const wthI = toMap(withdrawalIn);
  const expB = toMap(expenseBefore);
  const expI = toMap(expenseIn);
  const outB = toMap(transferOutBefore);
  const outI = toMap(transferOutIn);
  const inB = toMap(transferInBefore);
  const inI = toMap(transferInIn);
  const setB = toMap(settlementBefore);
  const setI = toMap(settlementIn);
  const refB = toMap(referralBefore);
  const refI = toMap(referralIn);

  return banks.map((bank) => {
    const bankId = String(bank._id);
    const base = asNumber(bank.openingBalance);
    const opening =
      base +
      asNumber(depB.get(bankId)) +
      asNumber(inB.get(bankId)) -
      asNumber(wthB.get(bankId)) -
      asNumber(expB.get(bankId)) -
      asNumber(outB.get(bankId)) -
      asNumber(refB.get(bankId)) +
      asNumber(setB.get(bankId));

    const periodDebits =
      asNumber(depI.get(bankId)) + asNumber(inI.get(bankId)) + Math.max(0, asNumber(setI.get(bankId)));
    const periodCredits =
      asNumber(wthI.get(bankId)) +
      asNumber(expI.get(bankId)) +
      asNumber(outI.get(bankId)) +
      asNumber(refI.get(bankId)) +
      Math.max(0, -asNumber(setI.get(bankId)));

    const closing =
      opening +
      asNumber(depI.get(bankId)) +
      asNumber(inI.get(bankId)) -
      asNumber(wthI.get(bankId)) -
      asNumber(expI.get(bankId)) -
      asNumber(outI.get(bankId)) -
      asNumber(refI.get(bankId)) +
      asNumber(setI.get(bankId));

    const side: BalanceSheetSide = closing >= 0 ? "asset" : "liability";
    return {
      ledgerId: bankId,
      name: bankDisplayName(bank),
      type: "bank" as const,
      openingBalance: round2(opening),
      periodDebits: round2(periodDebits),
      periodCredits: round2(periodCredits),
      closingBalance: round2(Math.abs(closing)),
      side,
      groupCode:
        closing >= 0
          ? BALANCE_SHEET_GROUP_CODES.BANK_ACCOUNTS
          : BALANCE_SHEET_GROUP_CODES.BANK_OVERDRAFTS,
    };
  });
}

async function DepositAggByBank(match: Record<string, unknown>) {
  const { DepositModel } = await import("../deposit/deposit.model");
  const { bankIds, ...rest } = match as { bankIds: Types.ObjectId[] } & Record<string, unknown>;
  return DepositModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    { $match: { bankId: { $in: bankIds }, ...rest } },
    { $group: { _id: "$bankId", totalAmount: { $sum: "$amount" } } },
  ]);
}

async function WithdrawalAggByBank(match: Record<string, unknown>) {
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
  const { bankIds, ...rest } = match as { bankIds: Types.ObjectId[] } & Record<string, unknown>;
  return WithdrawalModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    { $match: { payoutBankId: { $in: bankIds }, ...rest } },
    {
      $group: {
        _id: "$payoutBankId",
        totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
      },
    },
  ]);
}

async function ExpenseAggByBank(match: Record<string, unknown>) {
  const { bankIds, ...rest } = match as { bankIds: Types.ObjectId[] } & Record<string, unknown>;
  return ExpenseModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    { $match: { bankId: { $in: bankIds }, ...rest } },
    { $group: { _id: "$bankId", totalAmount: { $sum: "$amount" } } },
  ]);
}

async function LiabilityAggByBank(args: {
  bankIds: Types.ObjectId[];
  direction: "in" | "out";
} & Record<string, unknown>) {
  const { bankIds, direction, ...dateFilter } = args;
  const match =
    direction === "out"
      ? { fromAccountType: "bank", fromAccountId: { $in: bankIds }, ...dateFilter }
      : { toAccountType: "bank", toAccountId: { $in: bankIds }, ...dateFilter };
  const groupId = direction === "out" ? "$fromAccountId" : "$toAccountId";
  return LiabilityEntryModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    { $match: match },
    { $group: { _id: groupId, totalAmount: { $sum: "$amount" } } },
  ]);
}

async function SettlementAggByBank(match: Record<string, unknown>) {
  const { bankIds, ...rest } = match as { bankIds: Types.ObjectId[] } & Record<string, unknown>;
  return BankBalanceSettlementModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    { $match: { bankId: { $in: bankIds }, ...rest } },
    { $group: { _id: "$bankId", totalAmount: { $sum: "$signedAmount" } } },
  ]);
}

async function ReferralAggByBank(match: Record<string, unknown>) {
  const { bankIds, ...rest } = match as { bankIds: Types.ObjectId[] } & Record<string, unknown>;
  return ReferralAccrualModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
    {
      $match: {
        bankId: { $in: bankIds },
        status: "settled",
        settlementAccountType: "bank",
        ...rest,
      },
    },
    { $group: { _id: "$bankId", totalAmount: { $sum: { $ifNull: ["$accruedAmount", 0] } } } },
  ]);
}

async function getPersonLedgers(bounds: PeriodBounds): Promise<BalanceSheetLedger[]> {
  const { fromUtc, toUtc } = bounds;
  const persons = await LiabilityPersonModel.find({ isActive: true })
    .select({ _id: 1, name: 1, openingBalance: 1 })
    .lean();
  if (persons.length === 0) return [];

  const personIds = persons.map((p) => p._id);

  const [debitBefore, debitIn, creditBefore, creditIn] = await Promise.all([
    LiabilityEntryModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          fromAccountType: "person",
          fromAccountId: { $in: personIds },
          ...liabilityDateBeforeExpr(fromUtc),
        },
      },
      { $group: { _id: "$fromAccountId", totalAmount: { $sum: "$amount" } } },
    ]),
    LiabilityEntryModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          fromAccountType: "person",
          fromAccountId: { $in: personIds },
          ...liabilityDateRangeExpr(fromUtc, toUtc),
        },
      },
      { $group: { _id: "$fromAccountId", totalAmount: { $sum: "$amount" } } },
    ]),
    LiabilityEntryModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          toAccountType: "person",
          toAccountId: { $in: personIds },
          ...liabilityDateBeforeExpr(fromUtc),
        },
      },
      { $group: { _id: "$toAccountId", totalAmount: { $sum: "$amount" } } },
    ]),
    LiabilityEntryModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          toAccountType: "person",
          toAccountId: { $in: personIds },
          ...liabilityDateRangeExpr(fromUtc, toUtc),
        },
      },
      { $group: { _id: "$toAccountId", totalAmount: { $sum: "$amount" } } },
    ]),
  ]);

  const toMap = (rows: Array<{ _id?: unknown; totalAmount?: number }>) => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(String(row._id), asNumber(row.totalAmount));
    return map;
  };

  const dB = toMap(debitBefore);
  const dI = toMap(debitIn);
  const cB = toMap(creditBefore);
  const cI = toMap(creditIn);

  return persons.map((person) => {
    const id = String(person._id);
    // Platform view: positive closing = receivable (asset), negative = payable (liability)
    // closing = opening + credits(to) - debits(from)
    const opening =
      asNumber(person.openingBalance) + asNumber(cB.get(id)) - asNumber(dB.get(id));
    const periodDebits = asNumber(dI.get(id));
    const periodCredits = asNumber(cI.get(id));
    const closing = opening + periodCredits - periodDebits;
    const side: BalanceSheetSide = closing >= 0 ? "asset" : "liability";
    return {
      ledgerId: id,
      name: String(person.name ?? "Person"),
      type: "person" as const,
      openingBalance: round2(opening),
      periodDebits: round2(periodDebits),
      periodCredits: round2(periodCredits),
      closingBalance: round2(Math.abs(closing)),
      side,
      groupCode:
        closing >= 0 ? BALANCE_SHEET_GROUP_CODES.RECEIVABLES : BALANCE_SHEET_GROUP_CODES.PAYABLES,
    };
  });
}

async function getExchangeLedgers(
  bounds: PeriodBounds,
  exchangeObjectId: Types.ObjectId | null,
): Promise<BalanceSheetLedger[]> {
  const { fromUtc, toUtc } = bounds;
  const { DepositModel } = await import("../deposit/deposit.model");
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");

  const exchangeFilter = exchangeObjectId ? { _id: exchangeObjectId } : { status: "active" as const };
  const exchanges = await ExchangeModel.find(exchangeFilter)
    .select({ _id: 1, name: 1, openingBalance: 1 })
    .lean();
  if (exchanges.length === 0) return [];

  const exchangeIds = exchanges.map((e) => e._id);

  const depositEventExpr = {
    $ifNull: [
      "$entryAt",
      { $ifNull: ["$settledAt", { $ifNull: ["$exchangeActionAt", { $ifNull: ["$updatedAt", "$createdAt"] }] }] },
    ],
  };
  const withdrawalEventExpr = {
    $ifNull: ["$requestedAt", { $ifNull: ["$updatedAt", "$createdAt"] }],
  };

  const [depositPrior, depositIn, withdrawalPrior, withdrawalIn, topupPrior, topupIn] =
    await Promise.all([
      DepositModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { status: { $in: ["verified", "finalized"] }, player: { $exists: true, $ne: null } } },
        { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
        { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
        { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
        { $addFields: { eventAt: depositEventExpr } },
        { $match: { eventAt: { $lt: fromUtc } } },
        {
          $group: {
            _id: "$playerDoc.exchange",
            totalAmount: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
          },
        },
      ]),
      DepositModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { status: { $in: ["verified", "finalized"] }, player: { $exists: true, $ne: null } } },
        { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
        { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
        { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
        { $addFields: { eventAt: depositEventExpr } },
        { $match: { eventAt: { $gte: fromUtc, $lte: toUtc } } },
        {
          $group: {
            _id: "$playerDoc.exchange",
            totalAmount: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
          },
        },
      ]),
      WithdrawalModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { status: { $in: ["approved", "finalized"] }, player: { $exists: true, $ne: null } } },
        { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
        { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
        { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
        { $addFields: { eventAt: withdrawalEventExpr } },
        { $match: { eventAt: { $lt: fromUtc } } },
        {
          $group: {
            _id: "$playerDoc.exchange",
            totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          },
        },
      ]),
      WithdrawalModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { status: { $in: ["approved", "finalized"] }, player: { $exists: true, $ne: null } } },
        { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
        { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
        { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
        { $addFields: { eventAt: withdrawalEventExpr } },
        { $match: { eventAt: { $gte: fromUtc, $lte: toUtc } } },
        {
          $group: {
            _id: "$playerDoc.exchange",
            totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          },
        },
      ]),
      ExchangeTopupModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { exchangeId: { $in: exchangeIds }, createdAt: { $lt: fromUtc } } },
        { $group: { _id: "$exchangeId", totalAmount: { $sum: "$amount" } } },
      ]),
      ExchangeTopupModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
        { $match: { exchangeId: { $in: exchangeIds }, createdAt: { $gte: fromUtc, $lte: toUtc } } },
        { $group: { _id: "$exchangeId", totalAmount: { $sum: "$amount" } } },
      ]),
    ]);

  const toMap = (rows: Array<{ _id?: unknown; totalAmount?: number }>) => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(String(row._id), asNumber(row.totalAmount));
    return map;
  };

  const dP = toMap(depositPrior);
  const dI = toMap(depositIn);
  const wP = toMap(withdrawalPrior);
  const wI = toMap(withdrawalIn);
  const tP = toMap(topupPrior);
  const tI = toMap(topupIn);

  return exchanges.map((ex) => {
    const id = String(ex._id);
    const openingBase = asNumber(ex.openingBalance);
    const opening =
      openingBase - asNumber(dP.get(id)) + asNumber(wP.get(id)) + asNumber(tP.get(id));
    const periodDebits = asNumber(wI.get(id)) + asNumber(tI.get(id));
    const periodCredits = asNumber(dI.get(id));
    const closing = opening - periodCredits + periodDebits;
    return {
      ledgerId: id,
      name: String(ex.name ?? "Exchange"),
      type: "exchange" as const,
      openingBalance: round2(opening),
      periodDebits: round2(periodDebits),
      periodCredits: round2(periodCredits),
      closingBalance: round2(closing),
      side: "asset" as const,
      groupCode: BALANCE_SHEET_GROUP_CODES.EXCHANGE_FLOAT,
    };
  });
}

async function getPendingWithdrawalLedgers(
  bounds: PeriodBounds,
  exchangeObjectId: Types.ObjectId | null,
): Promise<BalanceSheetLedger[]> {
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
  const { toUtc } = bounds;

  // Outstanding stock as of toDate (requestedAt/createdAt <= toUtc)
  const txExpr = { $ifNull: ["$requestedAt", "$createdAt"] };
  const asOfMatch: Record<string, unknown> = {
    status: "requested",
    $expr: { $lte: [txExpr, toUtc] },
  };

  const pipeline: Record<string, unknown>[] = [
    { $match: asOfMatch },
    { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
    { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: true } },
  ];
  if (exchangeObjectId) {
    pipeline.push({ $match: { "playerDoc.exchange": exchangeObjectId } });
  }
  pipeline.push({
    $group: {
      _id: null,
      totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
      count: { $sum: 1 },
    },
  });

  const rows = await WithdrawalModel.aggregate<{ totalAmount: number; count: number }>(
    pipeline as never,
  );
  const total = asNumber(rows[0]?.totalAmount);
  if (total === 0) return [];
  return [
    {
      ledgerId: "pending_withdrawals",
      name: `Pending Withdrawals (${rows[0]?.count ?? 0})`,
      type: "withdrawal",
      openingBalance: 0,
      periodDebits: 0,
      periodCredits: round2(total),
      closingBalance: round2(total),
      side: "liability",
      groupCode: BALANCE_SHEET_GROUP_CODES.PENDING_WITHDRAWALS,
    },
  ];
}

async function getExpensesPayableLedgers(bounds: PeriodBounds): Promise<BalanceSheetLedger[]> {
  const { toUtc } = bounds;
  // Outstanding stock as of toDate (pending_audit with expenseDate <= toDate)
  const rows = await ExpenseModel.aggregate<{ totalAmount: number; count: number }>([
    {
      $match: {
        status: "pending_audit",
        expenseDate: { $lte: toUtc },
      },
    },
    { $group: { _id: null, totalAmount: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]);
  const total = asNumber(rows[0]?.totalAmount);
  if (total === 0) return [];
  return [
    {
      ledgerId: "expenses_payable",
      name: `Expenses Pending Audit (${rows[0]?.count ?? 0})`,
      type: "expense",
      openingBalance: 0,
      periodDebits: 0,
      periodCredits: round2(total),
      closingBalance: round2(total),
      side: "liability",
      groupCode: BALANCE_SHEET_GROUP_CODES.EXPENSES_PAYABLE,
    },
  ];
}

async function getIbCommissionLedgers(
  bounds: PeriodBounds,
  exchangeObjectId: Types.ObjectId | null,
): Promise<BalanceSheetLedger[]> {
  const { toUtc } = bounds;
  // Outstanding stock as of toDate (accrued with createdAt <= toDate)
  const match: Record<string, unknown> = {
    status: "accrued",
    createdAt: { $lte: toUtc },
  };
  if (exchangeObjectId) match.exchangeId = exchangeObjectId;

  const rows = await ReferralAccrualModel.aggregate<{ totalAmount: number; count: number }>([
    { $match: match },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: { $ifNull: ["$accruedAmount", 0] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const total = asNumber(rows[0]?.totalAmount);
  if (total === 0) return [];
  return [
    {
      ledgerId: "ib_commissions",
      name: `IB Commission Accrued (${rows[0]?.count ?? 0})`,
      type: "referral",
      openingBalance: 0,
      periodDebits: 0,
      periodCredits: round2(total),
      closingBalance: round2(total),
      side: "liability",
      groupCode: BALANCE_SHEET_GROUP_CODES.IB_COMMISSIONS,
    },
  ];
}

async function getPnLTotals(
  bounds: PeriodBounds,
  exchangeObjectId: Types.ObjectId | null,
): Promise<{ grossPL: number; netPL: number; retainedEarnings: number }> {
  const { DepositModel } = await import("../deposit/deposit.model");
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
  const { fromUtc, toUtc } = bounds;

  const depositMatch: Record<string, unknown> = {
    status: { $in: ["verified", "finalized"] },
    ...businessDateRangeExpr("entryAt", fromUtc, toUtc),
  };
  const withdrawalMatch: Record<string, unknown> = {
    status: { $in: ["approved", "finalized"] },
    ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
  };
  const expenseMatch: Record<string, unknown> = {
    status: "approved",
    expenseDate: { $gte: fromUtc, $lte: toUtc },
  };
  const ibMatch: Record<string, unknown> = {
    status: { $in: ["accrued", "settled"] },
    createdAt: { $gte: fromUtc, $lte: toUtc },
  };
  if (exchangeObjectId) ibMatch.exchangeId = exchangeObjectId;

  let scopedPlayerIds: Types.ObjectId[] | null = null;
  if (exchangeObjectId) {
    const { PlayerModel } = await import("../player/player.model");
    scopedPlayerIds = await PlayerModel.distinct("_id", {
      exchange: exchangeObjectId,
      isMigratedOldUser: false,
    });
    depositMatch.player = { $in: scopedPlayerIds };
    withdrawalMatch.player = { $in: scopedPlayerIds };
  }

  const [dep, wth, exp, ib] = await Promise.all([
    DepositModel.aggregate<{ total: number }>([
      { $match: depositMatch },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    WithdrawalModel.aggregate<{ total: number }>([
      { $match: withdrawalMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$payableAmount", "$amount"] } } } },
    ]),
    ExpenseModel.aggregate<{ total: number }>([
      { $match: expenseMatch },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    ReferralAccrualModel.aggregate<{ total: number }>([
      { $match: ibMatch },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$accruedAmount", 0] } } } },
    ]),
  ]);

  const deposits = asNumber(dep[0]?.total);
  const withdrawals = asNumber(wth[0]?.total);
  const expenses = asNumber(exp[0]?.total);
  const ibTotal = asNumber(ib[0]?.total);
  const grossPL = deposits - withdrawals;
  const netPL = grossPL - expenses - ibTotal;
  return {
    grossPL: round2(grossPL),
    netPL: round2(netPL),
    retainedEarnings: round2(netPL),
  };
}

type GroupDoc = {
  _id: Types.ObjectId;
  code: string;
  name: string;
  parentGroupId: Types.ObjectId | null;
  parentCode: string | null;
  side: BalanceSheetSide;
  level: number;
  sortOrder: number;
};

const EQUITY_ROOT_CODE = BALANCE_SHEET_GROUP_CODES.CAPITAL_RESERVES;
const EQUITY_CODES = new Set<string>([
  BALANCE_SHEET_GROUP_CODES.CAPITAL_RESERVES,
  BALANCE_SHEET_GROUP_CODES.EXCHANGE_CAPITAL,
  BALANCE_SHEET_GROUP_CODES.RETAINED_EARNINGS,
]);

function isEquityGroup(g: GroupDoc): boolean {
  return EQUITY_CODES.has(g.code) || (g.parentCode != null && EQUITY_CODES.has(g.parentCode));
}

function buildGroupTree(
  groups: GroupDoc[],
  ledgersByGroup: Map<string, BalanceSheetLedger[]>,
  showZeroBalances: boolean,
  filterSide?: BalanceSheetSide | "equity",
): BalanceSheetGroupNode[] {
  const byParent = new Map<string | null, GroupDoc[]>();
  for (const g of groups) {
    const key = g.parentGroupId ? String(g.parentGroupId) : null;
    const list = byParent.get(key) ?? [];
    list.push(g);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  const walk = (parentId: string | null): BalanceSheetGroupNode[] => {
    const children = byParent.get(parentId) ?? [];
    const nodes: BalanceSheetGroupNode[] = [];
    for (const g of children) {
      const equity = isEquityGroup(g);
      if (filterSide === "asset" && g.side !== "asset") continue;
      if (filterSide === "liability" && (g.side !== "liability" || equity)) continue;
      if (filterSide === "equity") {
        if (parentId === null && g.code !== EQUITY_ROOT_CODE) continue;
        if (parentId !== null && !equity) continue;
      }

      let ledgers = ledgersByGroup.get(g.code) ?? [];
      if (!showZeroBalances) {
        ledgers = ledgers.filter((l) => Math.abs(l.closingBalance) >= BALANCE_TOLERANCE);
      }
      const subGroups = walk(String(g._id));
      const total = round2(
        ledgers.reduce((s, l) => s + l.closingBalance, 0) +
          subGroups.reduce((s, sg) => s + sg.total, 0),
      );

      if (
        !showZeroBalances &&
        Math.abs(total) < BALANCE_TOLERANCE &&
        ledgers.length === 0 &&
        subGroups.length === 0
      ) {
        continue;
      }

      nodes.push({
        groupId: String(g._id),
        code: g.code,
        name: g.name,
        parentGroupId: g.parentGroupId ? String(g.parentGroupId) : null,
        parentCode: g.parentCode,
        side: g.side,
        level: g.level,
        sortOrder: g.sortOrder,
        ledgers,
        subGroups,
        total,
      });
    }
    return nodes;
  };

  return walk(null);
}

function sumGroupTotals(nodes: BalanceSheetGroupNode[]): number {
  return round2(nodes.reduce((s, n) => s + n.total, 0));
}

function applyCompare(
  current: BalanceSheetGroupNode[],
  compare: BalanceSheetGroupNode[] | null,
): BalanceSheetGroupNode[] {
  if (!compare) return current;
  const compareMap = new Map<string, BalanceSheetGroupNode>();
  const index = (nodes: BalanceSheetGroupNode[]) => {
    for (const n of nodes) {
      compareMap.set(n.code, n);
      index(n.subGroups);
    }
  };
  index(compare);

  const apply = (nodes: BalanceSheetGroupNode[]): BalanceSheetGroupNode[] =>
    nodes.map((n) => {
      const c = compareMap.get(n.code);
      const compareTotal = c?.total ?? 0;
      const ledgerCompare = new Map((c?.ledgers ?? []).map((l) => [l.ledgerId, l]));
      return {
        ...n,
        compareTotal,
        compareDelta: round2(n.total - compareTotal),
        ledgers: n.ledgers.map((l) => {
          const cl = ledgerCompare.get(l.ledgerId);
          const compareClosing = cl?.closingBalance ?? 0;
          return {
            ...l,
            compareClosingBalance: compareClosing,
            compareDelta: round2(l.closingBalance - compareClosing),
          };
        }),
        subGroups: apply(n.subGroups),
      };
    });

  return apply(current);
}

async function ensureDefaultGroups(): Promise<GroupDoc[]> {
  let groups = await BalanceSheetGroupModel.find({ isActive: true }).lean();
  if (groups.length === 0) {
    await seedDefaultBalanceSheetGroups();
    groups = await BalanceSheetGroupModel.find({ isActive: true }).lean();
  }
  return groups as GroupDoc[];
}

export async function seedDefaultBalanceSheetGroups(): Promise<void> {
  const defs: Array<{
    code: string;
    name: string;
    parentCode: string | null;
    side: BalanceSheetSide;
    level: number;
    sortOrder: number;
  }> = [
    { code: BALANCE_SHEET_GROUP_CODES.FIXED_ASSETS, name: "Fixed Assets", parentCode: null, side: "asset", level: 0, sortOrder: 10 },
    { code: BALANCE_SHEET_GROUP_CODES.CURRENT_ASSETS, name: "Current Assets", parentCode: null, side: "asset", level: 0, sortOrder: 20 },
    { code: BALANCE_SHEET_GROUP_CODES.BANK_ACCOUNTS, name: "Bank Accounts", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_ASSETS, side: "asset", level: 1, sortOrder: 21 },
    { code: BALANCE_SHEET_GROUP_CODES.CASH_IN_HAND, name: "Cash in Hand", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_ASSETS, side: "asset", level: 1, sortOrder: 22 },
    { code: BALANCE_SHEET_GROUP_CODES.RECEIVABLES, name: "Receivables", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_ASSETS, side: "asset", level: 1, sortOrder: 23 },
    { code: BALANCE_SHEET_GROUP_CODES.EXCHANGE_FLOAT, name: "Exchange Float", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_ASSETS, side: "asset", level: 1, sortOrder: 24 },
    { code: BALANCE_SHEET_GROUP_CODES.CAPITAL_RESERVES, name: "Capital & Reserves", parentCode: null, side: "liability", level: 0, sortOrder: 10 },
    { code: BALANCE_SHEET_GROUP_CODES.EXCHANGE_CAPITAL, name: "Exchange Capital", parentCode: BALANCE_SHEET_GROUP_CODES.CAPITAL_RESERVES, side: "liability", level: 1, sortOrder: 11 },
    { code: BALANCE_SHEET_GROUP_CODES.RETAINED_EARNINGS, name: "Retained Earnings", parentCode: BALANCE_SHEET_GROUP_CODES.CAPITAL_RESERVES, side: "liability", level: 1, sortOrder: 12 },
    { code: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, name: "Current Liabilities", parentCode: null, side: "liability", level: 0, sortOrder: 20 },
    { code: BALANCE_SHEET_GROUP_CODES.BANK_OVERDRAFTS, name: "Bank Overdrafts", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, side: "liability", level: 1, sortOrder: 21 },
    { code: BALANCE_SHEET_GROUP_CODES.PAYABLES, name: "Payables", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, side: "liability", level: 1, sortOrder: 22 },
    { code: BALANCE_SHEET_GROUP_CODES.PENDING_WITHDRAWALS, name: "Pending Withdrawals", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, side: "liability", level: 1, sortOrder: 23 },
    { code: BALANCE_SHEET_GROUP_CODES.EXPENSES_PAYABLE, name: "Expenses Payable", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, side: "liability", level: 1, sortOrder: 24 },
    { code: BALANCE_SHEET_GROUP_CODES.IB_COMMISSIONS, name: "IB Commissions", parentCode: BALANCE_SHEET_GROUP_CODES.CURRENT_LIABILITIES, side: "liability", level: 1, sortOrder: 25 },
  ];

  for (const def of defs) {
    await BalanceSheetGroupModel.updateOne(
      { code: def.code },
      {
        $set: {
          name: def.name,
          parentCode: def.parentCode,
          side: def.side,
          level: def.level,
          sortOrder: def.sortOrder,
          isSystem: true,
          isActive: true,
        },
        $setOnInsert: { code: def.code },
      },
      { upsert: true },
    );
  }

  const all = await BalanceSheetGroupModel.find({}).lean();
  const byCode = new Map(all.map((g) => [g.code, g]));
  for (const def of defs) {
    const parent = def.parentCode ? byCode.get(def.parentCode) : null;
    await BalanceSheetGroupModel.updateOne(
      { code: def.code },
      { $set: { parentGroupId: parent?._id ?? null } },
    );
  }
}

async function collectLedgersForPeriod(
  bounds: PeriodBounds,
  exchangeObjectId: Types.ObjectId | null,
): Promise<{ ledgers: BalanceSheetLedger[]; pnl: { grossPL: number; netPL: number; retainedEarnings: number } }> {
  const [banks, persons, exchanges, pendingWd, expensesPayable, ib, pnl] = await Promise.all([
    getBankLedgers(bounds),
    getPersonLedgers(bounds),
    getExchangeLedgers(bounds, exchangeObjectId),
    getPendingWithdrawalLedgers(bounds, exchangeObjectId),
    getExpensesPayableLedgers(bounds),
    getIbCommissionLedgers(bounds, exchangeObjectId),
    getPnLTotals(bounds, exchangeObjectId),
  ]);

  const retained: BalanceSheetLedger = {
    ledgerId: "retained_earnings",
    name: "Period Net P&L",
    type: "computed",
    openingBalance: 0,
    periodDebits: pnl.netPL < 0 ? round2(Math.abs(pnl.netPL)) : 0,
    periodCredits: pnl.netPL > 0 ? round2(pnl.netPL) : 0,
    closingBalance: round2(pnl.retainedEarnings),
    side: "liability",
    groupCode: BALANCE_SHEET_GROUP_CODES.RETAINED_EARNINGS,
  };

  return {
    ledgers: [...banks, ...persons, ...exchanges, ...pendingWd, ...expensesPayable, ...ib, retained],
    pnl,
  };
}

function groupLedgers(ledgers: BalanceSheetLedger[]): Map<string, BalanceSheetLedger[]> {
  const map = new Map<string, BalanceSheetLedger[]>();
  for (const l of ledgers) {
    const list = map.get(l.groupCode) ?? [];
    list.push(l);
    map.set(l.groupCode, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

function filterByGroup(
  nodes: BalanceSheetGroupNode[],
  groupId?: string,
  groupCode?: string,
): BalanceSheetGroupNode[] {
  if (!groupId && !groupCode) return nodes;
  const find = (list: BalanceSheetGroupNode[]): BalanceSheetGroupNode | null => {
    for (const n of list) {
      if ((groupId && n.groupId === groupId) || (groupCode && n.code === groupCode)) return n;
      const child = find(n.subGroups);
      if (child) return child;
    }
    return null;
  };
  const found = find(nodes);
  return found ? [found] : [];
}

async function buildBalanceSheetForBounds(
  bounds: PeriodBounds,
  query: BalanceSheetQuery,
  groups: GroupDoc[],
  exchangeObjectId: Types.ObjectId | null,
): Promise<{
  assets: BalanceSheetGroupNode[];
  liabilities: BalanceSheetGroupNode[];
  equity: BalanceSheetGroupNode[];
  totals: BalanceSheetResponse["totals"];
  difference: number;
  isBalanced: boolean;
}> {
  const { ledgers, pnl } = await collectLedgersForPeriod(bounds, exchangeObjectId);
  const byGroup = groupLedgers(ledgers);
  const showZero = Boolean(query.showZeroBalances);

  let assets = buildGroupTree(groups, byGroup, showZero, "asset");
  let liabilities = buildGroupTree(groups, byGroup, showZero, "liability");
  let equity = buildGroupTree(groups, byGroup, showZero, "equity");

  if (query.groupId || query.groupCode) {
    assets = filterByGroup(assets, query.groupId, query.groupCode);
    liabilities = filterByGroup(liabilities, query.groupId, query.groupCode);
    equity = filterByGroup(equity, query.groupId, query.groupCode);
  }

  const totalAssets = sumGroupTotals(assets);
  const totalLiabilitiesOps = sumGroupTotals(liabilities);
  const totalEquity = sumGroupTotals(equity);
  const totalLiabilities = round2(totalLiabilitiesOps + totalEquity);
  const difference = round2(totalAssets - totalLiabilities);
  const isBalanced = Math.abs(difference) <= BALANCE_TOLERANCE;

  return {
    assets,
    liabilities,
    equity,
    totals: {
      totalAssets,
      totalLiabilities: totalLiabilitiesOps,
      totalEquity,
      grossPL: pnl.grossPL,
      netPL: pnl.netPL,
    },
    difference,
    isBalanced,
  };
}

export async function getBalanceSheet(
  query: BalanceSheetQuery,
  options?: { timeZone?: string },
): Promise<BalanceSheetResponse> {
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

  const groups = await ensureDefaultGroups();
  const bounds: PeriodBounds = {
    fromUtc,
    toUtc,
    fromDate: query.fromDate,
    toDate: query.toDate,
  };

  const current = await buildBalanceSheetForBounds(bounds, query, groups, exchangeObjectId);

  const compareSpec = resolveCompareRange(
    query.fromDate,
    query.toDate,
    query.compare ?? "none",
    timeZone,
  );

  let compareFromDate: string | null = null;
  let compareToDate: string | null = null;
  if (compareSpec) {
    compareFromDate = compareSpec.compareFromDate;
    compareToDate = compareSpec.compareToDate;
    const cFrom = ymdToUtcStartInZone(compareFromDate, timeZone);
    const cTo = ymdToUtcEndInZone(compareToDate, timeZone);
    if (cFrom && cTo) {
      const compareResult = await buildBalanceSheetForBounds(
        { fromUtc: cFrom, toUtc: cTo, fromDate: compareFromDate, toDate: compareToDate },
        query,
        groups,
        exchangeObjectId,
      );
      current.assets = applyCompare(current.assets, compareResult.assets);
      current.liabilities = applyCompare(current.liabilities, compareResult.liabilities);
      current.equity = applyCompare(current.equity, compareResult.equity);
      current.totals.compareTotalAssets = compareResult.totals.totalAssets;
      current.totals.compareTotalLiabilities = compareResult.totals.totalLiabilities;
      current.totals.compareTotalEquity = compareResult.totals.totalEquity;
    }
  }

  return {
    meta: {
      fromDate: query.fromDate,
      toDate: query.toDate,
      exchangeId: query.exchangeId ?? null,
      timeZone,
      currency: query.currency ?? "PLATFORM",
      compare: query.compare ?? "none",
      compareFromDate,
      compareToDate,
      showZeroBalances: Boolean(query.showZeroBalances),
      isBalanced: current.isBalanced,
      difference: current.difference,
    },
    totals: current.totals,
    assets: current.assets,
    liabilities: current.liabilities,
    equity: current.equity,
  };
}

export async function getBalanceSheetSummary(
  query: BalanceSheetQuery,
  options?: { timeZone?: string },
) {
  const full = await getBalanceSheet(query, options);
  return {
    meta: full.meta,
    totals: full.totals,
  };
}

export async function listBalanceSheetGroups() {
  const groups = await ensureDefaultGroups();
  return groups
    .slice()
    .sort((a, b) => a.side.localeCompare(b.side) || a.sortOrder - b.sortOrder)
    .map((g) => ({
      groupId: String(g._id),
      code: g.code,
      name: g.name,
      parentGroupId: g.parentGroupId ? String(g.parentGroupId) : null,
      parentCode: g.parentCode,
      side: g.side,
      level: g.level,
      sortOrder: g.sortOrder,
    }));
}

export async function getBalanceSheetDrilldown(
  query: BalanceSheetDrilldownQuery,
  options?: { timeZone?: string },
) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const fromUtc = ymdToUtcStartInZone(query.fromDate, timeZone);
  const toUtc = ymdToUtcEndInZone(query.toDate, timeZone);
  if (!fromUtc || !toUtc) throw new AppError("VALIDATION_ERROR", "Invalid date range", 400);

  const skip = (query.page - 1) * query.pageSize;
  const exchangeObjectId =
    query.exchangeId && Types.ObjectId.isValid(query.exchangeId)
      ? new Types.ObjectId(query.exchangeId)
      : null;

  type DrillRow = {
    type: string;
    date: Date | string | null | undefined;
    amount: number;
    direction: string;
    reference?: string;
    status?: string;
  };

  const paginate = (all: DrillRow[]) => {
    all.sort(
      (a, b) => new Date(String(b.date ?? 0)).getTime() - new Date(String(a.date ?? 0)).getTime(),
    );
    return {
      rows: all.slice(skip, skip + query.pageSize),
      meta: { page: query.page, pageSize: query.pageSize, total: all.length },
    };
  };

  if (query.ledgerType === "bank" && Types.ObjectId.isValid(query.ledgerId)) {
    const bankId = new Types.ObjectId(query.ledgerId);
    const { DepositModel } = await import("../deposit/deposit.model");
    const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");

    const [deposits, withdrawals, expenses, liabilities, settlements, referrals] =
      await Promise.all([
        DepositModel.find({
          bankId,
          status: { $in: ["verified", "finalized"] },
          ...businessDateRangeExpr("entryAt", fromUtc, toUtc),
        })
          .select({ amount: 1, utr: 1, entryAt: 1, createdAt: 1, status: 1 })
          .lean(),
        WithdrawalModel.find({
          payoutBankId: bankId,
          status: { $in: ["approved", "finalized"] },
          ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
        })
          .select({ amount: 1, payableAmount: 1, utr: 1, requestedAt: 1, createdAt: 1, status: 1 })
          .lean(),
        ExpenseModel.find({
          bankId,
          status: "approved",
          settlementAccountType: "bank",
          expenseDate: { $gte: fromUtc, $lte: toUtc },
        })
          .select({ amount: 1, description: 1, expenseDate: 1, status: 1 })
          .lean(),
        LiabilityEntryModel.find({
          $or: [
            { fromAccountType: "bank", fromAccountId: bankId },
            { toAccountType: "bank", toAccountId: bankId },
          ],
          ...liabilityDateRangeExpr(fromUtc, toUtc),
        })
          .select({
            amount: 1,
            entryDate: 1,
            entryType: 1,
            remark: 1,
            fromAccountType: 1,
            toAccountType: 1,
            createdAt: 1,
          })
          .lean(),
        BankBalanceSettlementModel.find({
          bankId,
          effectiveAt: { $gte: fromUtc, $lte: toUtc },
        })
          .select({ signedAmount: 1, effectiveAt: 1, reason: 1 })
          .lean(),
        ReferralAccrualModel.find({
          bankId,
          status: "settled",
          settlementAccountType: "bank",
          createdAt: { $gte: fromUtc, $lte: toUtc },
        })
          .select({ accruedAmount: 1, createdAt: 1, settledAt: 1, settlementRemark: 1, status: 1 })
          .lean(),
      ]);

    const rows: DrillRow[] = [];
    for (const d of deposits) {
      rows.push({
        type: "deposit",
        date: d.entryAt ?? d.createdAt,
        amount: asNumber(d.amount),
        direction: "in",
        reference: d.utr,
        status: d.status,
      });
    }
    for (const w of withdrawals) {
      rows.push({
        type: "withdrawal",
        date: w.requestedAt ?? w.createdAt,
        amount: asNumber(w.payableAmount ?? w.amount),
        direction: "out",
        reference: w.utr,
        status: w.status,
      });
    }
    for (const e of expenses) {
      rows.push({
        type: "expense",
        date: e.expenseDate,
        amount: asNumber(e.amount),
        direction: "out",
        reference: e.description,
        status: e.status,
      });
    }
    for (const le of liabilities) {
      rows.push({
        type: "liability",
        date: le.entryDate ?? le.createdAt,
        amount: asNumber(le.amount),
        direction: le.fromAccountType === "bank" ? "out" : "in",
        reference: le.remark || le.entryType,
        status: le.entryType,
      });
    }
    for (const s of settlements) {
      const amt = asNumber(s.signedAmount);
      rows.push({
        type: "settlement",
        date: s.effectiveAt,
        amount: Math.abs(amt),
        direction: amt >= 0 ? "in" : "out",
        reference: s.reason,
        status: "settlement",
      });
    }
    for (const r of referrals) {
      rows.push({
        type: "referral",
        date: r.settledAt ?? r.createdAt,
        amount: asNumber(r.accruedAmount),
        direction: "out",
        reference: r.settlementRemark || "IB settle",
        status: r.status,
      });
    }
    return paginate(rows);
  }

  if (query.ledgerType === "person" && Types.ObjectId.isValid(query.ledgerId)) {
    const personId = new Types.ObjectId(query.ledgerId);
    const match = {
      $or: [
        { fromAccountType: "person", fromAccountId: personId },
        { toAccountType: "person", toAccountId: personId },
      ],
      ...liabilityDateRangeExpr(fromUtc, toUtc),
    };
    const [list, count] = await Promise.all([
      LiabilityEntryModel.find(match)
        .sort({ entryDate: -1 })
        .skip(skip)
        .limit(query.pageSize)
        .lean(),
      LiabilityEntryModel.countDocuments(match),
    ]);
    return {
      rows: list.map((le) => ({
        type: "liability",
        date: le.entryDate,
        amount: asNumber(le.amount),
        direction: le.fromAccountType === "person" ? "out" : "in",
        reference: le.remark || le.referenceNo || le.entryType,
        status: le.entryType,
      })),
      meta: { page: query.page, pageSize: query.pageSize, total: count },
    };
  }

  // Synthetic / computed ledgers
  if (query.ledgerId === "expenses_payable" || query.ledgerType === "expense") {
    const list = await ExpenseModel.find({
      status: "pending_audit",
      expenseDate: { $lte: toUtc },
    })
      .select({ amount: 1, description: 1, expenseDate: 1, status: 1 })
      .sort({ expenseDate: -1 })
      .lean();
    return paginate(
      list.map((e) => ({
        type: "expense",
        date: e.expenseDate,
        amount: asNumber(e.amount),
        direction: "out",
        reference: e.description,
        status: e.status,
      })),
    );
  }

  if (query.ledgerId === "pending_withdrawals" || query.ledgerType === "withdrawal") {
    const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
    const txExpr = { $ifNull: ["$requestedAt", "$createdAt"] };
    const pipeline: Record<string, unknown>[] = [
      {
        $match: {
          status: "requested",
          $expr: { $lte: [txExpr, toUtc] },
        },
      },
      { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: true } },
    ];
    if (exchangeObjectId) {
      pipeline.push({ $match: { "playerDoc.exchange": exchangeObjectId } });
    }
    pipeline.push({
      $project: {
        amount: 1,
        payableAmount: 1,
        utr: 1,
        requestedAt: 1,
        createdAt: 1,
        status: 1,
      },
    });
    const list = await WithdrawalModel.aggregate(pipeline as never);
    return paginate(
      list.map((w: { payableAmount?: number; amount?: number; requestedAt?: Date; createdAt?: Date; utr?: string; status?: string }) => ({
        type: "withdrawal",
        date: w.requestedAt ?? w.createdAt,
        amount: asNumber(w.payableAmount ?? w.amount),
        direction: "out",
        reference: w.utr,
        status: w.status,
      })),
    );
  }

  if (query.ledgerId === "ib_commissions" || query.ledgerType === "referral") {
    const match: Record<string, unknown> = {
      status: "accrued",
      createdAt: { $lte: toUtc },
    };
    if (exchangeObjectId) match.exchangeId = exchangeObjectId;
    const list = await ReferralAccrualModel.find(match)
      .select({ accruedAmount: 1, createdAt: 1, status: 1, settlementRemark: 1 })
      .sort({ createdAt: -1 })
      .lean();
    return paginate(
      list.map((r) => ({
        type: "referral",
        date: r.createdAt,
        amount: asNumber(r.accruedAmount),
        direction: "out",
        reference: r.settlementRemark || "IB accrued",
        status: r.status,
      })),
    );
  }

  if (query.ledgerId === "retained_earnings" || query.ledgerType === "computed") {
    const { DepositModel } = await import("../deposit/deposit.model");
    const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
    let scopedPlayerIds: Types.ObjectId[] | null = null;
    if (exchangeObjectId) {
      const { PlayerModel } = await import("../player/player.model");
      scopedPlayerIds = await PlayerModel.distinct("_id", {
        exchange: exchangeObjectId,
        isMigratedOldUser: false,
      });
    }
    const depositMatch: Record<string, unknown> = {
      status: { $in: ["verified", "finalized"] },
      ...businessDateRangeExpr("entryAt", fromUtc, toUtc),
    };
    const withdrawalMatch: Record<string, unknown> = {
      status: { $in: ["approved", "finalized"] },
      ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
    };
    if (scopedPlayerIds) {
      depositMatch.player = { $in: scopedPlayerIds };
      withdrawalMatch.player = { $in: scopedPlayerIds };
    }
    const [deposits, withdrawals, expenses, ib] = await Promise.all([
      DepositModel.find(depositMatch)
        .select({ amount: 1, entryAt: 1, createdAt: 1, utr: 1, status: 1 })
        .lean(),
      WithdrawalModel.find(withdrawalMatch)
        .select({ amount: 1, payableAmount: 1, requestedAt: 1, createdAt: 1, utr: 1, status: 1 })
        .lean(),
      ExpenseModel.find({
        status: "approved",
        expenseDate: { $gte: fromUtc, $lte: toUtc },
      })
        .select({ amount: 1, expenseDate: 1, description: 1, status: 1 })
        .lean(),
      ReferralAccrualModel.find({
        status: { $in: ["accrued", "settled"] },
        createdAt: { $gte: fromUtc, $lte: toUtc },
        ...(exchangeObjectId ? { exchangeId: exchangeObjectId } : {}),
      })
        .select({ accruedAmount: 1, createdAt: 1, status: 1 })
        .lean(),
    ]);
    const rows: DrillRow[] = [];
    for (const d of deposits) {
      rows.push({
        type: "deposit",
        date: d.entryAt ?? d.createdAt,
        amount: asNumber(d.amount),
        direction: "in",
        reference: d.utr,
        status: d.status,
      });
    }
    for (const w of withdrawals) {
      rows.push({
        type: "withdrawal",
        date: w.requestedAt ?? w.createdAt,
        amount: asNumber(w.payableAmount ?? w.amount),
        direction: "out",
        reference: w.utr,
        status: w.status,
      });
    }
    for (const e of expenses) {
      rows.push({
        type: "expense",
        date: e.expenseDate,
        amount: asNumber(e.amount),
        direction: "out",
        reference: e.description,
        status: e.status,
      });
    }
    for (const r of ib) {
      rows.push({
        type: "referral",
        date: r.createdAt,
        amount: asNumber(r.accruedAmount),
        direction: "out",
        reference: "IB",
        status: r.status,
      });
    }
    return paginate(rows);
  }

  if (query.ledgerType === "exchange" && Types.ObjectId.isValid(query.ledgerId)) {
    const { DepositModel } = await import("../deposit/deposit.model");
    const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
    const { PlayerModel } = await import("../player/player.model");
    const exchangeId = new Types.ObjectId(query.ledgerId);
    const playerIds = await PlayerModel.distinct("_id", {
      exchange: exchangeId,
      isMigratedOldUser: false,
    });
    const [deposits, withdrawals, topups] = await Promise.all([
      DepositModel.find({
        player: { $in: playerIds },
        status: { $in: ["verified", "finalized"] },
        ...businessDateRangeExpr("entryAt", fromUtc, toUtc),
      })
        .select({ amount: 1, entryAt: 1, createdAt: 1, utr: 1, status: 1 })
        .lean(),
      WithdrawalModel.find({
        player: { $in: playerIds },
        status: { $in: ["approved", "finalized"] },
        ...businessDateRangeExpr("requestedAt", fromUtc, toUtc),
      })
        .select({ amount: 1, payableAmount: 1, requestedAt: 1, createdAt: 1, utr: 1, status: 1 })
        .lean(),
      ExchangeTopupModel.find({
        exchangeId,
        createdAt: { $gte: fromUtc, $lte: toUtc },
      })
        .select({ amount: 1, createdAt: 1, remark: 1 })
        .lean(),
    ]);
    const rows: DrillRow[] = [];
    for (const d of deposits) {
      rows.push({
        type: "deposit",
        date: d.entryAt ?? d.createdAt,
        amount: asNumber(d.amount),
        direction: "in",
        reference: d.utr,
        status: d.status,
      });
    }
    for (const w of withdrawals) {
      rows.push({
        type: "withdrawal",
        date: w.requestedAt ?? w.createdAt,
        amount: asNumber(w.payableAmount ?? w.amount),
        direction: "out",
        reference: w.utr,
        status: w.status,
      });
    }
    for (const t of topups) {
      rows.push({
        type: "topup",
        date: t.createdAt,
        amount: asNumber(t.amount),
        direction: "out",
        reference: t.remark || "Exchange topup",
        status: "topup",
      });
    }
    return paginate(rows);
  }

  return {
    rows: [],
    meta: { page: query.page, pageSize: query.pageSize, total: 0 },
  };
}

export async function exportBalanceSheetDrilldownToBuffer(
  query: {
    fromDate: string;
    toDate: string;
    exchangeId?: string;
    ledgerId: string;
    ledgerType: BalanceSheetDrilldownQuery["ledgerType"];
  },
  options?: { timeZone?: string },
): Promise<Buffer> {
  const data = await getBalanceSheetDrilldown(
    {
      ...query,
      page: 1,
      pageSize: 5000,
    } as BalanceSheetDrilldownQuery,
    options,
  );

  const sheet = data.rows.map((r) => ({
    Date: r.date ? new Date(String(r.date)).toISOString() : "",
    Type: r.type,
    Amount: r.amount,
    Direction: r.direction,
    Reference: r.reference ?? "",
    Status: r.status ?? "",
  }));

  return generateMultiSheetExcelBuffer([
    {
      name: "Ledger",
      data: sheet,
      columns: [
        { header: "Date", key: "Date" },
        { header: "Type", key: "Type" },
        { header: "Amount", key: "Amount" },
        { header: "Direction", key: "Direction" },
        { header: "Reference", key: "Reference" },
        { header: "Status", key: "Status" },
      ],
    },
  ]);
}

function flattenGroups(
  nodes: BalanceSheetGroupNode[],
  section: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (list: BalanceSheetGroupNode[], indent: number) => {
    for (const g of list) {
      out.push({
        Section: section,
        Group: `${"  ".repeat(indent)}${g.name}`,
        Code: g.code,
        Side: g.side,
        Total: g.total,
        "Compare Total": g.compareTotal ?? "",
        Delta: g.compareDelta ?? "",
      });
      for (const l of g.ledgers) {
        out.push({
          Section: section,
          Group: `${"  ".repeat(indent + 1)}${l.name}`,
          Code: l.groupCode,
          Side: l.side,
          Total: l.closingBalance,
          "Compare Total": l.compareClosingBalance ?? "",
          Delta: l.compareDelta ?? "",
        });
      }
      walk(g.subGroups, indent + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

export async function exportBalanceSheetToBuffer(
  query: BalanceSheetQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const data = await getBalanceSheet(query, options);
  const summary = [
    { KPI: "Total Assets", Value: data.totals.totalAssets },
    { KPI: "Total Liabilities", Value: data.totals.totalLiabilities },
    { KPI: "Total Equity", Value: data.totals.totalEquity },
    { KPI: "Gross P&L", Value: data.totals.grossPL },
    { KPI: "Net P&L", Value: data.totals.netPL },
    { KPI: "Balanced", Value: data.meta.isBalanced ? "Yes" : "No" },
    { KPI: "Difference", Value: data.meta.difference },
    { KPI: "From", Value: data.meta.fromDate },
    { KPI: "To", Value: data.meta.toDate },
  ];

  const detail = [
    ...flattenGroups(data.assets, "Assets"),
    ...flattenGroups(data.liabilities, "Liabilities"),
    ...flattenGroups(data.equity, "Equity"),
  ];

  return generateMultiSheetExcelBuffer([
    {
      name: "Summary",
      data: summary,
      columns: [
        { header: "KPI", key: "KPI" },
        { header: "Value", key: "Value" },
      ],
    },
    {
      name: "Detail",
      data: detail,
      columns: [
        { header: "Section", key: "Section" },
        { header: "Group", key: "Group" },
        { header: "Code", key: "Code" },
        { header: "Side", key: "Side" },
        { header: "Total", key: "Total" },
        { header: "Compare Total", key: "Compare Total" },
        { header: "Delta", key: "Delta" },
      ],
    },
  ]);
}

export async function createBalanceSheetSnapshot(
  body: CreateBalanceSheetSnapshotBody,
  actorId: Types.ObjectId,
  options?: { timeZone?: string },
) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const sheet = await getBalanceSheet(
    {
      fromDate: body.fromDate,
      toDate: body.toDate,
      exchangeId: body.exchangeId,
      groupCode: undefined,
      currency: undefined,
      showZeroBalances: true,
      includeSubGroups: true,
      compare: "none",
    },
    { timeZone },
  );

  const fromUtc = ymdToUtcStartInZone(body.fromDate, timeZone)!;
  const toUtc = ymdToUtcEndInZone(body.toDate, timeZone)!;

  const doc = await BalanceSheetSnapshotModel.create({
    asOfDate: toUtc,
    fromDate: fromUtc,
    toDate: toUtc,
    exchangeId:
      body.exchangeId && Types.ObjectId.isValid(body.exchangeId)
        ? new Types.ObjectId(body.exchangeId)
        : null,
    timeZone,
    payload: sheet as unknown as Record<string, unknown>,
    totalAssets: sheet.totals.totalAssets,
    totalLiabilities: sheet.totals.totalLiabilities,
    totalEquity: sheet.totals.totalEquity,
    isBalanced: sheet.meta.isBalanced,
    createdBy: actorId,
  });

  return {
    snapshotId: String(doc._id),
    asOfDate: body.toDate,
    totalAssets: doc.totalAssets,
    totalLiabilities: doc.totalLiabilities,
    totalEquity: doc.totalEquity,
    isBalanced: doc.isBalanced,
  };
}

/** Pure helpers exported for unit tests */
export const balanceSheetMath = {
  round2,
  resolveCompareRange,
  BALANCE_TOLERANCE,
};
