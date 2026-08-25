import { Aggregate, PipelineStage, Types } from "mongoose";
import { generateExcelBuffer, generateMultiSheetExcelBuffer } from "../../shared/services/excel.service";
import type { z } from "zod";
import { AuditLogModel } from "../audit/audit.model";
import { BankBalanceSettlementModel } from "../bank/bank-balance-settlement.model";
import { BankModel } from "../bank/bank.model";
import { ExchangeModel } from "../exchange/exchange.model";
import { ExchangeTopupModel } from "../exchange-topup/exchange-topup.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { PlayerModel } from "../player/player.model";
import { UserModel } from "../users/user.model";
import { ExpenseModel, type ExpenseStatus } from "../expense/expense.model";
import { AUDIT_ENTITY_AUTH } from "../../shared/constants/auditEntities";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  formatDateTimeForTimeZone,
  ymdToUtcEnd as ymdToUtcEndInZone,
  ymdToUtcStart as ymdToUtcStartInZone,
} from "../../shared/utils/timezone";
import {
  dashboardSummaryQuerySchema,
  expenseAnalysisFilterQuerySchema,
  expenseAnalysisRecordsQuerySchema,
  transactionHistoryQuerySchema,
} from "./reports.validation";

type DashboardSummaryQuery = z.infer<typeof dashboardSummaryQuerySchema>;
type ExpenseAnalysisFilterQuery = z.infer<typeof expenseAnalysisFilterQuerySchema>;
type ExpenseAnalysisRecordsQuery = z.infer<typeof expenseAnalysisRecordsQuerySchema>;
type TransactionHistoryQuery = z.infer<typeof transactionHistoryQuerySchema>;

/** Transaction reports exclude login audits; login history is auth rows only. */
export type AuditHistoryScope = "transactions" | "login";

function escapeRegexFragment(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type DateRangeQuery = {
  fromDate?: string;
  toDate?: string;
};

function buildDateFilter(query: DateRangeQuery, timeZone: string) {
  if (!query.fromDate && !query.toDate) return {};
  const createdAt: { $gte?: Date; $lte?: Date } = {};
  if (query.fromDate) createdAt.$gte = ymdToUtcStartInZone(query.fromDate, timeZone) ?? undefined;
  if (query.toDate) createdAt.$lte = ymdToUtcEndInZone(query.toDate, timeZone) ?? undefined;
  return { createdAt };
}

const DASHBOARD_DEFAULT_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function resolveDashboardRange(query: DashboardSummaryQuery, timeZone: string): { fromDate: string; toDate: string } {
  const todayYmd = formatDateForTimeZone(new Date(), timeZone);

  const toDate = query.toDate ?? todayYmd;
  const fromDate =
    query.fromDate ??
    formatDateForTimeZone(
      new Date((ymdToUtcStartInZone(toDate, timeZone) ?? new Date()).getTime() - (DASHBOARD_DEFAULT_DAYS - 1) * ONE_DAY_MS),
      timeZone,
    );

  if (fromDate <= toDate) return { fromDate, toDate };
  return { fromDate: toDate, toDate: fromDate };
}

function dateRangeYmd(fromDate: string, toDate: string, timeZone: string): string[] {
  const startMs = (ymdToUtcStartInZone(fromDate, timeZone) ?? new Date()).getTime();
  const endMs = (ymdToUtcStartInZone(toDate, timeZone) ?? new Date()).getTime();
  const days: string[] = [];
  for (let cursor = startMs; cursor <= endMs; cursor += ONE_DAY_MS) {
    days.push(formatDateForTimeZone(new Date(cursor), timeZone));
  }
  return days;
}

function resolveTodayRangeForTimeZone(
  timeZone: string,
  now: Date = new Date(),
): { startUtc: Date; endUtc: Date; ymd: string } {
  const ymd = formatDateForTimeZone(now, timeZone);
  const startUtc = ymdToUtcStartInZone(ymd, timeZone) ?? now;
  const endUtc = ymdToUtcEndInZone(ymd, timeZone) ?? now;
  return {
    startUtc,
    endUtc,
    ymd,
  };
}

type DashboardStatusFilter = "all" | "pending" | "approved" | "rejected";
type DashboardTxnTypeFilter = "all" | "deposit" | "withdrawal" | "expense";

type DashboardFilterContext = {
  dateFilter: Record<string, unknown>;
  depositDateFilter: Record<string, unknown>;
  withdrawalDateFilter: Record<string, unknown>;
  expenseDateFilter: Record<string, unknown>;
  appliedRange: { fromDate: string; toDate: string };
  exchangeObjectId: Types.ObjectId | null;
  scopedPlayerIds: Types.ObjectId[] | null;
  depositFilter: Record<string, unknown>;
  withdrawalFilter: Record<string, unknown>;
  expenseFilter: Record<string, unknown>;
  exchangeStatsFilter: Record<string, unknown>;
};

type ExchangeBalanceSummary = {
  periodOpeningBalance: number;
  periodClosingBalance: number;
};

function businessDateRangeExpr(field: "entryAt" | "requestedAt", startUtc: Date | null, endUtc: Date | null) {
  if (!startUtc || !endUtc) return {};
  const txExpr = { $ifNull: [`$${field}`, "$createdAt"] };
  return {
    $expr: {
      $and: [{ $gte: [txExpr, startUtc] }, { $lte: [txExpr, endUtc] }],
    },
  };
}

function businessDateBeforeExpr(field: "entryAt" | "requestedAt", beforeUtc: Date | null) {
  if (!beforeUtc) return {};
  const txExpr = { $ifNull: [`$${field}`, "$createdAt"] };
  return {
    $expr: {
      $lt: [txExpr, beforeUtc],
    },
  };
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

function liabilityDateBeforeExpr(beforeUtc: Date | null) {
  if (!beforeUtc) return {};
  const txExpr = { $ifNull: ["$entryDate", "$createdAt"] };
  return {
    $expr: {
      $lt: [txExpr, beforeUtc],
    },
  };
}

function statusFilterForDeposit(status: DashboardStatusFilter | undefined): Record<string, unknown> {
  if (status === "pending") return { status: { $in: ["pending", "not_settled"] } };
  if (status === "approved") return { status: { $in: ["verified", "finalized"] } };
  if (status === "rejected") return { status: "rejected" };
  return {};
}

function statusFilterForWithdrawal(status: DashboardStatusFilter | undefined): Record<string, unknown> {
  if (status === "pending") return { status: "requested" };
  if (status === "approved") return { status: "approved" };
  if (status === "rejected") return { status: "rejected" };
  return {};
}

function statusFilterForExpense(status: DashboardStatusFilter | undefined): Record<string, unknown> {
  if (status === "pending") return { status: "pending_audit" };
  if (status === "approved") return { status: "approved" };
  if (status === "rejected") return { status: "rejected" };
  return {};
}

async function buildDashboardFilterContext(
  query: DashboardSummaryQuery,
  timeZone: string,
): Promise<DashboardFilterContext> {
  const appliedRange = resolveDashboardRange(query, timeZone);
  const rangeStartUtc = ymdToUtcStartInZone(appliedRange.fromDate, timeZone);
  const rangeEndUtc = ymdToUtcEndInZone(appliedRange.toDate, timeZone);
  const dateFilter = {
    createdAt: {
      $gte: rangeStartUtc,
      $lte: rangeEndUtc,
    },
  };
  const depositDateFilter = businessDateRangeExpr("entryAt", rangeStartUtc, rangeEndUtc);
  const withdrawalDateFilter = businessDateRangeExpr("requestedAt", rangeStartUtc, rangeEndUtc);
  const expenseDateFilter = {
    expenseDate: {
      $gte: rangeStartUtc,
      $lte: rangeEndUtc,
    },
  };

  const exchangeObjectId =
    query.exchangeId && Types.ObjectId.isValid(query.exchangeId) ? new Types.ObjectId(query.exchangeId) : null;
  const playerObjectId =
    query.playerId && Types.ObjectId.isValid(query.playerId) ? new Types.ObjectId(query.playerId) : null;
  const bankObjectId = query.bankId && Types.ObjectId.isValid(query.bankId) ? new Types.ObjectId(query.bankId) : null;
  const scopedPlayerIds = exchangeObjectId
    ? await (await import("../player/player.model")).PlayerModel.distinct("_id", {
        exchange: exchangeObjectId,
        isMigratedOldUser: false,
      })
    : null;

  const playerFilter =
    scopedPlayerIds && playerObjectId
      ? { player: { $in: scopedPlayerIds.filter((id) => id.equals(playerObjectId)) } }
      : scopedPlayerIds
        ? { player: { $in: scopedPlayerIds } }
        : playerObjectId
          ? { player: playerObjectId }
          : {};

  const minAmount = query.amountFrom != null ? Number(query.amountFrom) : undefined;
  const maxAmount = query.amountTo != null ? Number(query.amountTo) : undefined;
  const amountFilter =
    minAmount != null || maxAmount != null
      ? {
          amount: {
            ...(minAmount != null ? { $gte: minAmount } : {}),
            ...(maxAmount != null ? { $lte: maxAmount } : {}),
          },
        }
      : {};

  const search = query.search?.trim();
  const depositSearchFilter = search
    ? {
        $or: [
          { utr: { $regex: escapeRegexFragment(search), $options: "i" } },
          { bankName: { $regex: escapeRegexFragment(search), $options: "i" } },
        ],
      }
    : {};
  const withdrawalSearchFilter = search
    ? {
        $or: [
          { utr: { $regex: escapeRegexFragment(search), $options: "i" } },
          { bankName: { $regex: escapeRegexFragment(search), $options: "i" } },
          { playerName: { $regex: escapeRegexFragment(search), $options: "i" } },
        ],
      }
    : {};
  const expenseSearchFilter = search
    ? {
        $or: [
          { description: { $regex: escapeRegexFragment(search), $options: "i" } },
          { bankName: { $regex: escapeRegexFragment(search), $options: "i" } },
        ],
      }
    : {};

  const status = query.status as DashboardStatusFilter | undefined;
  const transactionType = (query.transactionType as DashboardTxnTypeFilter | undefined) ?? "all";
  const isDepositAllowed = transactionType === "all" || transactionType === "deposit";
  const isWithdrawalAllowed = transactionType === "all" || transactionType === "withdrawal";
  const isExpenseAllowed = transactionType === "all" || transactionType === "expense";

  const depositFilter = isDepositAllowed
    ? {
        ...depositDateFilter,
        ...playerFilter,
        ...(bankObjectId ? { bankId: bankObjectId } : {}),
        ...amountFilter,
        ...statusFilterForDeposit(status),
        ...depositSearchFilter,
      }
    : { _id: { $exists: false } };

  const withdrawalFilter = isWithdrawalAllowed
    ? {
        ...withdrawalDateFilter,
        ...playerFilter,
        ...amountFilter,
        ...statusFilterForWithdrawal(status),
        ...withdrawalSearchFilter,
      }
    : { _id: { $exists: false } };

  const expenseFilter = isExpenseAllowed
    ? {
        ...expenseDateFilter,
        ...amountFilter,
        ...(bankObjectId ? { bankId: bankObjectId } : {}),
        ...statusFilterForExpense(status),
        ...expenseSearchFilter,
      }
    : { _id: { $exists: false } };

  const exchangeStatsFilter = exchangeObjectId ? { _id: exchangeObjectId } : {};

  return {
    dateFilter,
    depositDateFilter,
    withdrawalDateFilter,
    expenseDateFilter,
    appliedRange,
    exchangeObjectId,
    scopedPlayerIds,
    depositFilter,
    withdrawalFilter,
    expenseFilter,
    exchangeStatsFilter,
  };
}

async function getExchangePeriodBalancesForDashboard(args: {
  exchangeIds: Types.ObjectId[];
  fromUtc: Date | null;
  toUtc: Date | null;
  DepositModel: {
    aggregate: <T = unknown>(pipeline?: PipelineStage[]) => Aggregate<T[]>;
  };
  WithdrawalModel: {
    aggregate: <T = unknown>(pipeline?: PipelineStage[]) => Aggregate<T[]>;
  };
}): Promise<Map<string, ExchangeBalanceSummary>> {
  const { exchangeIds, fromUtc, toUtc, DepositModel, WithdrawalModel } = args;
  const balanceMap = new Map<string, ExchangeBalanceSummary>();
  if (exchangeIds.length === 0) return balanceMap;

  const exchanges = await ExchangeModel.find({ _id: { $in: exchangeIds } })
    .select({ _id: 1, openingBalance: 1 })
    .lean();
  if (exchanges.length === 0) return balanceMap;

  if (!fromUtc || !toUtc) {
    for (const row of exchanges) {
      const opening = Number(row.openingBalance ?? 0);
      balanceMap.set(String(row._id), {
        periodOpeningBalance: opening,
        periodClosingBalance: opening,
      });
    }
    return balanceMap;
  }

  const depositEventExpr = {
    $ifNull: ["$entryAt", { $ifNull: ["$settledAt", { $ifNull: ["$exchangeActionAt", { $ifNull: ["$updatedAt", "$createdAt"] }] }] }],
  };
  const withdrawalEventExpr = {
    $ifNull: ["$requestedAt", { $ifNull: ["$updatedAt", "$createdAt"] }],
  };

  const [depositPrior, depositInRange, withdrawalPrior, withdrawalInRange, topupPrior, topupInRange] = await Promise.all([
    DepositModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          status: { $in: ["verified", "finalized"] },
          player: { $exists: true, $ne: null },
        },
      },
      { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
      { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
      { $addFields: { eventAt: depositEventExpr } },
      { $match: { eventAt: { $lt: fromUtc } } },
      { $group: { _id: "$playerDoc.exchange", totalAmount: { $sum: { $ifNull: ["$totalAmount", "$amount"] } } } },
    ]),
    DepositModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          status: { $in: ["verified", "finalized"] },
          player: { $exists: true, $ne: null },
        },
      },
      { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
      { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
      { $addFields: { eventAt: depositEventExpr } },
      { $match: { eventAt: { $gte: fromUtc, $lte: toUtc } } },
      { $group: { _id: "$playerDoc.exchange", totalAmount: { $sum: { $ifNull: ["$totalAmount", "$amount"] } } } },
    ]),
    WithdrawalModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          status: { $in: ["approved", "finalized"] },
          player: { $exists: true, $ne: null },
        },
      },
      { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
      { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
      { $addFields: { eventAt: withdrawalEventExpr } },
      { $match: { eventAt: { $lt: fromUtc } } },
      { $group: { _id: "$playerDoc.exchange", totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } } } },
    ]),
    WithdrawalModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      {
        $match: {
          status: { $in: ["approved", "finalized"] },
          player: { $exists: true, $ne: null },
        },
      },
      { $lookup: { from: "players", localField: "player", foreignField: "_id", as: "playerDoc" } },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
      { $match: { "playerDoc.exchange": { $in: exchangeIds } } },
      { $addFields: { eventAt: withdrawalEventExpr } },
      { $match: { eventAt: { $gte: fromUtc, $lte: toUtc } } },
      { $group: { _id: "$playerDoc.exchange", totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } } } },
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

  const toAmountMap = (rows: Array<{ _id: Types.ObjectId; totalAmount?: number }>) => {
    const out = new Map<string, number>();
    for (const row of rows) out.set(String(row._id), Number(row.totalAmount ?? 0));
    return out;
  };

  const depositPriorMap = toAmountMap(depositPrior);
  const depositRangeMap = toAmountMap(depositInRange);
  const withdrawalPriorMap = toAmountMap(withdrawalPrior);
  const withdrawalRangeMap = toAmountMap(withdrawalInRange);
  const topupPriorMap = toAmountMap(topupPrior);
  const topupRangeMap = toAmountMap(topupInRange);

  for (const row of exchanges) {
    const exchangeId = String(row._id);
    const openingBase = Number(row.openingBalance ?? 0);
    const periodOpeningBalance =
      openingBase -
      Number(depositPriorMap.get(exchangeId) ?? 0) +
      Number(withdrawalPriorMap.get(exchangeId) ?? 0) +
      Number(topupPriorMap.get(exchangeId) ?? 0);
    const periodClosingBalance =
      periodOpeningBalance -
      Number(depositRangeMap.get(exchangeId) ?? 0) +
      Number(withdrawalRangeMap.get(exchangeId) ?? 0) +
      Number(topupRangeMap.get(exchangeId) ?? 0);

    balanceMap.set(exchangeId, { periodOpeningBalance, periodClosingBalance });
  }
  return balanceMap;
}

export async function getDashboardSummary(
  query: DashboardSummaryQuery,
  options?: { timeZone?: string },
) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const { DepositModel } = await import("../deposit/deposit.model");
  const { WithdrawalModel } = await import("../withdrawal/withdrawal.model");
  const {
    appliedRange,
    exchangeObjectId,
    scopedPlayerIds,
    depositFilter,
    withdrawalFilter,
    expenseFilter,
    exchangeStatsFilter,
  } = await buildDashboardFilterContext(query, timeZone);
  const rangeStartUtc = ymdToUtcStartInZone(appliedRange.fromDate, timeZone);
  const rangeEndUtc = ymdToUtcEndInZone(appliedRange.toDate, timeZone);
  const selectedBankObjectId =
    query.bankId && Types.ObjectId.isValid(query.bankId) ? new Types.ObjectId(query.bankId) : null;
  const txType = (query.transactionType as DashboardTxnTypeFilter | undefined) ?? "all";
  const status = query.status as DashboardStatusFilter | undefined;
  const includeTransferSummary = txType === "all";
  const minAmount = query.amountFrom != null ? Number(query.amountFrom) : undefined;
  const maxAmount = query.amountTo != null ? Number(query.amountTo) : undefined;
  const liabilityAmountFilter =
    minAmount != null || maxAmount != null
      ? {
          amount: {
            ...(minAmount != null ? { $gte: minAmount } : {}),
            ...(maxAmount != null ? { $lte: maxAmount } : {}),
          },
        }
      : {};
  const liabilitySearchText = query.search?.trim();
  const liabilitySearchFilter = liabilitySearchText
    ? {
        $or: [
          { referenceNo: { $regex: escapeRegexFragment(liabilitySearchText), $options: "i" } },
          { remark: { $regex: escapeRegexFragment(liabilitySearchText), $options: "i" } },
          { entryType: { $regex: escapeRegexFragment(liabilitySearchText), $options: "i" } },
        ],
      }
    : {};
  const bankSelectionLiabilityFilter = selectedBankObjectId
    ? {
        $or: [{ fromAccountId: selectedBankObjectId }, { toAccountId: selectedBankObjectId }],
      }
    : {};
  const liabilityBaseFilter = includeTransferSummary
    ? { ...liabilityAmountFilter, ...liabilitySearchFilter, ...bankSelectionLiabilityFilter }
    : { _id: { $exists: false } };

  const { $expr: _depositDateExpr, ...depositFilterNoDate } = depositFilter as Record<string, unknown>;
  const { $expr: _withdrawalDateExpr, ...withdrawalFilterNoDate } = withdrawalFilter as Record<string, unknown>;
  const { expenseDate: _expenseDateRange, ...expenseFilterNoDate } = expenseFilter as Record<string, unknown>;

  const depositBalanceStatusFilter =
    status === "all" || !status ? { status: { $in: ["verified", "finalized"] } } : {};
  const withdrawalBalanceStatusFilter = status === "all" || !status ? { status: "approved" } : {};
  const expenseBalanceStatusFilter = status === "all" || !status ? { status: "approved" } : {};

  const depositBankRangeFilter = {
    ...depositFilterNoDate,
    ...businessDateRangeExpr("entryAt", rangeStartUtc, rangeEndUtc),
    ...depositBalanceStatusFilter,
  };
  const depositBankPriorFilter = {
    ...depositFilterNoDate,
    ...businessDateBeforeExpr("entryAt", rangeStartUtc),
    ...depositBalanceStatusFilter,
  };
  const withdrawalBankRangeFilter = {
    ...withdrawalFilterNoDate,
    ...businessDateRangeExpr("requestedAt", rangeStartUtc, rangeEndUtc),
    ...(selectedBankObjectId ? { payoutBankId: selectedBankObjectId } : {}),
    ...withdrawalBalanceStatusFilter,
  };
  const withdrawalBankPriorFilter = {
    ...withdrawalFilterNoDate,
    ...businessDateBeforeExpr("requestedAt", rangeStartUtc),
    ...(selectedBankObjectId ? { payoutBankId: selectedBankObjectId } : {}),
    ...withdrawalBalanceStatusFilter,
  };
  const expenseBankRangeFilter = {
    ...expenseFilterNoDate,
    expenseDate: {
      ...(rangeStartUtc ? { $gte: rangeStartUtc } : {}),
      ...(rangeEndUtc ? { $lte: rangeEndUtc } : {}),
    },
    ...expenseBalanceStatusFilter,
  };
  const expenseBankPriorFilter = {
    ...expenseFilterNoDate,
    expenseDate: {
      ...(rangeStartUtc ? { $lt: rangeStartUtc } : {}),
    },
    ...expenseBalanceStatusFilter,
  };
  const transferOutRangeFilter = {
    ...liabilityBaseFilter,
    fromAccountType: "bank",
    ...liabilityDateRangeExpr(rangeStartUtc, rangeEndUtc),
  };
  const transferOutPriorFilter = {
    ...liabilityBaseFilter,
    fromAccountType: "bank",
    ...liabilityDateBeforeExpr(rangeStartUtc),
  };
  const transferInRangeFilter = {
    ...liabilityBaseFilter,
    toAccountType: "bank",
    ...liabilityDateRangeExpr(rangeStartUtc, rangeEndUtc),
  };
  const transferInPriorFilter = {
    ...liabilityBaseFilter,
    toAccountType: "bank",
    ...liabilityDateBeforeExpr(rangeStartUtc),
  };

  const settlementBankBase = selectedBankObjectId ? { bankId: selectedBankObjectId } : {};
  const settlementBankPriorFilter: Record<string, unknown> = {
    ...settlementBankBase,
    ...(rangeStartUtc ? { effectiveAt: { $lt: rangeStartUtc } } : { _id: null }),
  };
  const settlementBankRangeFilter: Record<string, unknown> = {
    ...settlementBankBase,
    ...(rangeStartUtc && rangeEndUtc
      ? { effectiveAt: { $gte: rangeStartUtc, $lte: rangeEndUtc } }
      : { _id: null }),
  };

  const todayRange = resolveTodayRangeForTimeZone(timeZone);
  const periodPlayerFilter = {
    isMigratedOldUser: false,
    createdAt: {
      $gte: rangeStartUtc,
      $lte: rangeEndUtc,
    },
    ...(exchangeObjectId ? { exchange: exchangeObjectId } : {}),
  };
  const firstDepositBaseMatch: Record<string, unknown> = {
    status: { $in: ["verified", "finalized"] },
    player: scopedPlayerIds ? { $in: scopedPlayerIds } : { $exists: true, $ne: null },
  };

  /* ── Raw aggregation promises ──────────────────────────────────── */
  const [
    depositAgg,
    withdrawalAgg,
    expenseAgg,
    exchangeStats,
    totalUsers,
    recentDeposits,
    recentWithdrawals,
    depositTrend,
    withdrawalTrend,
    exchangeDeposits,
    exchangeWithdrawals,
    periodNewPlayersCount,
    firstTimeDepositPeriodAgg,
    exchangeNewPlayersAgg,
    exchangeFirstTimeDepositAgg,
    activeBanks,
    depositByBankInRange,
    depositByBankBeforeRange,
    withdrawalByBankInRange,
    withdrawalByBankBeforeRange,
    expenseByBankInRange,
    expenseByBankBeforeRange,
    transferOutByBankInRange,
    transferOutByBankBeforeRange,
    transferInByBankInRange,
    transferInByBankBeforeRange,
    settlementByBankBeforeRange,
    settlementByBankInRange,
  ] = await Promise.all([
    // Deposit: group by status → totalAmount, count, bonusTotal
    DepositModel.aggregate([
      { $match: { ...depositFilter } },
      {
        $group: {
          _id: "$status",
          totalAmount: { $sum: "$amount" },
          bonusTotal: { $sum: { $ifNull: ["$bonusAmount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Withdrawal: group by status → totalAmount, payableAmount, count
    WithdrawalModel.aggregate([
      { $match: { ...withdrawalFilter } },
      {
        $group: {
          _id: "$status",
          totalAmount: { $sum: "$amount" },
          payableTotal: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          reverseBonusTotal: { $sum: { $ifNull: ["$reverseBonus", 0] } },
          count: { $sum: 1 },
        },
      },
    ]),

    // Expense: group by status
    ExpenseModel.aggregate([
      { $match: { ...expenseFilter } },
      {
        $group: {
          _id: "$status",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),

    // Exchange active/total
    exchangeObjectId
      ? Promise.all([
          ExchangeModel.countDocuments({ ...exchangeStatsFilter }),
          ExchangeModel.countDocuments({ ...exchangeStatsFilter, status: "active" }),
        ])
      : Promise.all([
          ExchangeModel.countDocuments({}),
          ExchangeModel.countDocuments({ status: "active" }),
        ]),

    // Total active users
    UserModel.countDocuments({ status: "active" }),

    // Recent deposits (last 10, all statuses)
    DepositModel.find({ ...depositFilter })
      .sort({ entryAt: -1, createdAt: -1 })
      .limit(10)
      .populate("player", "playerId name")
      .populate("createdBy", "fullName username")
      .lean(),

    // Recent withdrawals (last 10, all statuses)
    WithdrawalModel.find({ ...withdrawalFilter })
      .sort({ requestedAt: -1, createdAt: -1 })
      .limit(10)
      .populate("player", "playerId name")
      .populate("createdBy", "fullName username")
      .lean(),

    // Deposit daily trend
    DepositModel.aggregate([
      {
        $match: {
          ...depositFilter,
          ...(query.status === "all" || !query.status ? { status: { $ne: "rejected" } } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: { $ifNull: ["$entryAt", "$createdAt"] }, timezone: timeZone },
          },
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Withdrawal daily trend
    WithdrawalModel.aggregate([
      {
        $match: {
          ...withdrawalFilter,
          ...(query.status === "all" || !query.status ? { status: { $ne: "rejected" } } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$requestedAt", "$createdAt"] },
              timezone: timeZone,
            },
          },
          totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Exchange deposits breakdown
    DepositModel.aggregate([
      { $match: { ...depositFilter, ...(query.status === "all" || !query.status ? { status: { $ne: "rejected" } } : {}) } },
      {
        $lookup: {
          from: "players",
          localField: "player",
          foreignField: "_id",
          as: "playerDoc",
        },
      },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "exchanges",
          localField: "playerDoc.exchange",
          foreignField: "_id",
          as: "exchangeDoc",
        },
      },
      { $unwind: { path: "$exchangeDoc", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ["$exchangeDoc._id", "unknown"] },
          name: { $first: { $ifNull: ["$exchangeDoc.name", "Unknown"] } },
          depositTotal: { $sum: "$amount" },
          depositVerified: { $sum: { $cond: [{ $in: ["$status", ["verified", "finalized"]] }, "$amount", 0] } },
          bonusTotal: { $sum: { $ifNull: ["$bonusAmount", 0] } },
        },
      },
    ]),

    // Exchange withdrawals breakdown
    WithdrawalModel.aggregate([
      { $match: { ...withdrawalFilter, ...(query.status === "all" || !query.status ? { status: { $ne: "rejected" } } : {}) } },
      {
        $lookup: {
          from: "players",
          localField: "player",
          foreignField: "_id",
          as: "playerDoc",
        },
      },
      { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "exchanges",
          localField: "playerDoc.exchange",
          foreignField: "_id",
          as: "exchangeDoc",
        },
      },
      { $unwind: { path: "$exchangeDoc", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ["$exchangeDoc._id", "unknown"] },
          name: { $first: { $ifNull: ["$exchangeDoc.name", "Unknown"] } },
          withdrawalTotal: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          withdrawalApproved: { $sum: { $cond: [{ $eq: ["$status", "approved"] }, { $ifNull: ["$payableAmount", "$amount"] }, 0] } },
          reverseBonusTotal: { $sum: { $ifNull: ["$reverseBonus", 0] } },
        },
      },
    ]),

    PlayerModel.countDocuments(periodPlayerFilter),

    scopedPlayerIds && scopedPlayerIds.length === 0
      ? Promise.resolve([{ totalAmount: 0 }])
      : DepositModel.aggregate([
          { $match: firstDepositBaseMatch },
          {
            $lookup: {
              from: "players",
              localField: "player",
              foreignField: "_id",
              as: "playerDoc",
            },
          },
          { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
          { $match: { "playerDoc.isMigratedOldUser": false } },
          {
            $addFields: {
              firstDepositEventAt: { $ifNull: ["$entryAt", "$createdAt"] },
            },
          },
          { $match: { firstDepositEventAt: { $type: "date" } } },
          { $sort: { player: 1, firstDepositEventAt: 1, createdAt: 1, _id: 1 } },
          {
            $group: {
              _id: "$player",
              firstDepositAt: { $first: "$firstDepositEventAt" },
              firstDepositAmount: { $first: "$amount" },
            },
          },
          {
            $match: {
              firstDepositAt: {
                $gte: rangeStartUtc,
                $lte: rangeEndUtc,
              },
            },
          },
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$firstDepositAmount" },
            },
          },
        ]),

    PlayerModel.aggregate([
      { $match: periodPlayerFilter },
      {
        $group: {
          _id: "$exchange",
          newPlayers: { $sum: 1 },
        },
      },
    ]),

    scopedPlayerIds && scopedPlayerIds.length === 0
      ? Promise.resolve([])
      : DepositModel.aggregate([
          { $match: firstDepositBaseMatch },
          {
            $lookup: {
              from: "players",
              localField: "player",
              foreignField: "_id",
              as: "playerDoc",
            },
          },
          { $unwind: { path: "$playerDoc", preserveNullAndEmptyArrays: false } },
          { $match: { "playerDoc.isMigratedOldUser": false } },
          {
            $addFields: {
              firstDepositEventAt: "$entryAt",
            },
          },
          { $match: { firstDepositEventAt: { $type: "date" } } },
          { $sort: { player: 1, firstDepositEventAt: 1, createdAt: 1, _id: 1 } },
          {
            $group: {
              _id: "$player",
              firstDepositAt: { $first: "$firstDepositEventAt" },
              firstDepositAmount: { $first: "$amount" },
            },
          },
          {
            $match: {
              firstDepositAt: {
                $gte: rangeStartUtc,
                $lte: rangeEndUtc,
              },
            },
          },
          ...(exchangeObjectId ? [{ $match: { "playerDoc.exchange": exchangeObjectId } }] : []),
          {
            $group: {
              _id: "$playerDoc.exchange",
              firstTimeDepositAmount: { $sum: "$firstDepositAmount" },
            },
          },
        ]),

    BankModel.find({ status: "active" })
      .select({ _id: 1, holderName: 1, bankName: 1, openingBalance: 1 })
      .lean(),

    DepositModel.aggregate([
      { $match: depositBankRangeFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    DepositModel.aggregate([
      { $match: depositBankPriorFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),

    WithdrawalModel.aggregate([
      { $match: withdrawalBankRangeFilter },
      {
        $group: {
          _id: "$payoutBankId",
          totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
          count: { $sum: 1 },
        },
      },
    ]),
    WithdrawalModel.aggregate([
      { $match: withdrawalBankPriorFilter },
      {
        $group: {
          _id: "$payoutBankId",
          totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
        },
      },
    ]),

    ExpenseModel.aggregate([
      { $match: expenseBankRangeFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    ExpenseModel.aggregate([
      { $match: expenseBankPriorFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),

    LiabilityEntryModel.aggregate([
      { $match: transferOutRangeFilter },
      {
        $group: {
          _id: "$fromAccountId",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    LiabilityEntryModel.aggregate([
      { $match: transferOutPriorFilter },
      {
        $group: {
          _id: "$fromAccountId",
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),

    LiabilityEntryModel.aggregate([
      { $match: transferInRangeFilter },
      {
        $group: {
          _id: "$toAccountId",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    LiabilityEntryModel.aggregate([
      { $match: transferInPriorFilter },
      {
        $group: {
          _id: "$toAccountId",
          totalAmount: { $sum: "$amount" },
        },
      },
    ]),

    BankBalanceSettlementModel.aggregate([
      { $match: settlementBankPriorFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$signedAmount" },
          count: { $sum: 1 },
        },
      },
    ]),
    BankBalanceSettlementModel.aggregate([
      { $match: settlementBankRangeFilter },
      {
        $group: {
          _id: "$bankId",
          totalAmount: { $sum: "$signedAmount" },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  /* ── Aggregate deposit KPIs ────────────────────────────────────── */
  let depositTotal = 0, depositCount = 0, depositPendingCount = 0,
    depositPendingAmount = 0, depositVerifiedAmount = 0, depositVerifiedCount = 0,
    depositRejectedCount = 0, bonusTotal = 0;

  for (const row of depositAgg) {
    if (row._id === "rejected") {
      depositRejectedCount = row.count ?? 0;
      continue;
    }
    
    depositTotal += row.totalAmount ?? 0;
    depositCount += row.count ?? 0;
    bonusTotal += row.bonusTotal ?? 0;
    
    if (row._id === "pending" || row._id === "not_settled") {
      depositPendingCount += row.count ?? 0;
      depositPendingAmount += row.totalAmount ?? 0;
    }
    if (row._id === "verified" || row._id === "finalized") {
      depositVerifiedAmount += row.totalAmount ?? 0;
      depositVerifiedCount += row.count ?? 0;
    }
  }

  /* ── Aggregate withdrawal KPIs ─────────────────────────────────── */
  let withdrawalTotal = 0, withdrawalCount = 0, withdrawalPendingCount = 0,
    withdrawalPendingAmount = 0, withdrawalApprovedAmount = 0,
    withdrawalApprovedCount = 0, withdrawalRejectedCount = 0, reverseBonusTotal = 0;

  for (const row of withdrawalAgg) {
    if (row._id === "rejected") {
      withdrawalRejectedCount = row.count ?? 0;
      continue;
    }
    
    withdrawalTotal += row.payableTotal ?? row.totalAmount ?? 0;
    withdrawalCount += row.count ?? 0;
    reverseBonusTotal += row.reverseBonusTotal ?? 0;
    
    if (row._id === "requested") {
      withdrawalPendingCount = row.count ?? 0;
      withdrawalPendingAmount = row.payableTotal ?? row.totalAmount ?? 0;
    }
    if (row._id === "approved") {
      withdrawalApprovedAmount += row.payableTotal ?? row.totalAmount ?? 0;
      withdrawalApprovedCount += row.count ?? 0;
    }
  }

  /* ── Aggregate expense KPIs ────────────────────────────────────── */
  let expenseTotal = 0, expenseCount = 0, expensePendingCount = 0,
    expenseApprovedAmount = 0;

  for (const row of expenseAgg) {
    if (row._id === "rejected") {
      continue;
    }
    
    expenseTotal += row.totalAmount ?? 0;
    expenseCount += row.count ?? 0;
    if (row._id === "pending_audit") expensePendingCount = row.count ?? 0;
    if (row._id === "approved") expenseApprovedAmount += row.totalAmount ?? 0;
  }

  /* ── P&L calculations ──────────────────────────────────────────── */
  const grossPL = depositVerifiedAmount - withdrawalApprovedAmount;
  const netPL = grossPL - expenseApprovedAmount;

  /* ── Exchange stats ────────────────────────────────────────────── */
  const [exchangeTotal, exchangeActive] = exchangeStats;

  /* ── Build daily trend (fill missing days with 0) ──────────────── */
  const allDays = dateRangeYmd(appliedRange.fromDate, appliedRange.toDate, timeZone);

  const depositTrendMap = new Map(depositTrend.map((r: { _id: string; totalAmount: number; count: number }) => [r._id, r]));
  const withdrawalTrendMap = new Map(withdrawalTrend.map((r: { _id: string; totalAmount: number; count: number }) => [r._id, r]));

  const trendData = allDays.map((day) => {
    const dep = depositTrendMap.get(day) as { totalAmount: number; count: number } | undefined;
    const wth = withdrawalTrendMap.get(day) as { totalAmount: number; count: number } | undefined;
    return {
      date: day,
      depositAmount: dep?.totalAmount ?? 0,
      depositCount: dep?.count ?? 0,
      withdrawalAmount: wth?.totalAmount ?? 0,
      withdrawalCount: wth?.count ?? 0,
    };
  });

  /* ── Recent activity (merge + sort) ───────────────────────────── */
  type AnyRow = Record<string, unknown>;
  const recentActivity = [
    ...(recentDeposits as unknown as AnyRow[]).map((d) => ({
      _id: String(d._id),
      type: "deposit" as const,
      amount: Number(d.amount ?? 0),
      status: String(d.status ?? ""),
      playerName: (d.player as AnyRow | undefined)?.name ?? d.playerName ?? "",
      createdBy: (d.createdBy as AnyRow | undefined)?.fullName ?? "",
      bankName: String(d.bankName ?? ""),
      utr: String(d.utr ?? ""),
      createdAt: d.entryAt ?? d.createdAt,
    })),
    ...(recentWithdrawals as unknown as AnyRow[]).map((w) => ({
      _id: String(w._id),
      type: "withdrawal" as const,
      amount: Number(w.amount ?? 0),
      status: String(w.status ?? ""),
      playerName: String(w.playerName ?? ""),
      createdBy: (w.createdBy as AnyRow | undefined)?.fullName ?? "",
      bankName: String(w.bankName ?? ""),
      utr: String(w.utr ?? ""),
      createdAt: w.requestedAt ?? w.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime())
    .slice(0, 20);

  /* ── Exchange Wise Breakdown (Merge & Sort) ───────────────────── */
  const exchangeMap = new Map<
    string,
    {
      exchangeId: string;
      name: string;
      depositTotal: number;
      depositVerified: number;
      withdrawalTotal: number;
      withdrawalApproved: number;
      bonusGiven: number;
      bonusRecovered: number;
    }
  >();
  const getExchangeObj = (id: string, name: string) => {
    let current = exchangeMap.get(id);
    if (!current) {
      current = {
        exchangeId: id,
        name,
        depositTotal: 0,
        depositVerified: 0,
        withdrawalTotal: 0,
        withdrawalApproved: 0,
        bonusGiven: 0,
        bonusRecovered: 0,
      };
      exchangeMap.set(id, current);
    }
    return current;
  };

  for (const row of exchangeDeposits) {
    const obj = getExchangeObj(String(row._id), String(row.name));
    obj.depositTotal = row.depositTotal ?? 0;
    obj.depositVerified = row.depositVerified ?? 0;
    obj.bonusGiven = row.bonusTotal ?? 0;
  }

  for (const row of exchangeWithdrawals) {
    const obj = getExchangeObj(String(row._id), String(row.name));
    obj.withdrawalTotal = row.withdrawalTotal ?? 0;
    obj.withdrawalApproved = row.withdrawalApproved ?? 0;
    obj.bonusRecovered = row.reverseBonusTotal ?? 0;
  }

  const exchangesBreakdown = Array.from(exchangeMap.values())
    .map((e) => ({ ...e, exchangeIdString: String(e.exchangeId) }))
    .map((e) => ({
      ...e,
      exchangeObjectId: Types.ObjectId.isValid(e.exchangeIdString) ? new Types.ObjectId(e.exchangeIdString) : null,
    }));
  const exchangeBalanceMap = await getExchangePeriodBalancesForDashboard({
    exchangeIds: exchangesBreakdown
      .map((row) => row.exchangeObjectId)
      .filter((value): value is Types.ObjectId => value instanceof Types.ObjectId),
    fromUtc: rangeStartUtc,
    toUtc: rangeEndUtc,
    DepositModel,
    WithdrawalModel,
  });

  const exchangesBreakdownWithBalances = exchangesBreakdown
    .map((e) => ({
      ...e,
      exchangeId: e.exchangeIdString,
      newPlayers:
        exchangeNewPlayersAgg.find((row: { _id?: unknown; newPlayers?: number }) => String(row._id) === e.exchangeId)
          ?.newPlayers ?? 0,
      firstTimeDepositAmount:
        exchangeFirstTimeDepositAgg.find(
          (row: { _id?: unknown; firstTimeDepositAmount?: number }) => String(row._id) === e.exchangeId,
        )?.firstTimeDepositAmount ?? 0,
      netPL: e.depositVerified - e.withdrawalApproved,
      netBonus: e.bonusGiven - e.bonusRecovered,
      periodOpeningBalance: e.exchangeObjectId ? exchangeBalanceMap.get(e.exchangeIdString)?.periodOpeningBalance ?? 0 : 0,
      periodClosingBalance: e.exchangeObjectId ? exchangeBalanceMap.get(e.exchangeIdString)?.periodClosingBalance ?? 0 : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const firstTimeDepositAmount =
    (firstTimeDepositPeriodAgg as Array<{ totalAmount?: number }>)[0]?.totalAmount ?? 0;

  const asNumber = (value: unknown) => Number(value ?? 0);
  const groupToAmountMap = (rows: Array<{ _id?: unknown; totalAmount?: number }>) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const id = String(row._id ?? "");
      if (!Types.ObjectId.isValid(id)) continue;
      map.set(id, asNumber(row.totalAmount));
    }
    return map;
  };
  const groupToCountMap = (rows: Array<{ _id?: unknown; count?: number }>) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const id = String(row._id ?? "");
      if (!Types.ObjectId.isValid(id)) continue;
      map.set(id, asNumber(row.count));
    }
    return map;
  };

  const depositInRangeMap = groupToAmountMap(depositByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>);
  const depositBeforeMap = groupToAmountMap(depositByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>);
  const depositCountMap = groupToCountMap(depositByBankInRange as Array<{ _id?: unknown; count?: number }>);
  const withdrawalInRangeMap = groupToAmountMap(withdrawalByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>);
  const withdrawalBeforeMap = groupToAmountMap(
    withdrawalByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const withdrawalCountMap = groupToCountMap(withdrawalByBankInRange as Array<{ _id?: unknown; count?: number }>);
  const expenseInRangeMap = groupToAmountMap(expenseByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>);
  const expenseBeforeMap = groupToAmountMap(expenseByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>);
  const expenseCountMap = groupToCountMap(expenseByBankInRange as Array<{ _id?: unknown; count?: number }>);
  const transferOutInRangeMap = groupToAmountMap(
    transferOutByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const transferOutBeforeMap = groupToAmountMap(
    transferOutByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const transferOutCountMap = groupToCountMap(transferOutByBankInRange as Array<{ _id?: unknown; count?: number }>);
  const transferInInRangeMap = groupToAmountMap(
    transferInByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const transferInBeforeMap = groupToAmountMap(
    transferInByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const transferInCountMap = groupToCountMap(transferInByBankInRange as Array<{ _id?: unknown; count?: number }>);
  const settlementBeforeMap = groupToAmountMap(
    settlementByBankBeforeRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const settlementInRangeMap = groupToAmountMap(
    settlementByBankInRange as Array<{ _id?: unknown; totalAmount?: number }>,
  );
  const settlementCountMap = groupToCountMap(
    settlementByBankInRange as Array<{ _id?: unknown; count?: number }>,
  );

  const banksBreakdown = (activeBanks as Array<{ _id: Types.ObjectId; holderName?: string; bankName?: string; openingBalance?: number }>)
    .map((bank) => {
      const bankId = String(bank._id);
      const baseOpeningBalance = asNumber(bank.openingBalance);
      const openingBalance =
        baseOpeningBalance +
        asNumber(depositBeforeMap.get(bankId)) +
        asNumber(transferInBeforeMap.get(bankId)) -
        asNumber(withdrawalBeforeMap.get(bankId)) -
        asNumber(expenseBeforeMap.get(bankId)) -
        asNumber(transferOutBeforeMap.get(bankId)) +
        asNumber(settlementBeforeMap.get(bankId));

      const deposit = asNumber(depositInRangeMap.get(bankId));
      const withdrawal = asNumber(withdrawalInRangeMap.get(bankId));
      const expenses = asNumber(expenseInRangeMap.get(bankId));
      const transferOut = asNumber(transferOutInRangeMap.get(bankId));
      const transferIn = asNumber(transferInInRangeMap.get(bankId));
      const depositCount = asNumber(depositCountMap.get(bankId));
      const withdrawalCount = asNumber(withdrawalCountMap.get(bankId));
      const expenseCount = asNumber(expenseCountMap.get(bankId));
      const transferOutCount = asNumber(transferOutCountMap.get(bankId));
      const transferInCount = asNumber(transferInCountMap.get(bankId));
      const settlementInRange = asNumber(settlementInRangeMap.get(bankId));
      const settlementInRangeCount = asNumber(settlementCountMap.get(bankId));
      // Total txns in period — sum of the five type counts above
      const entries =
        depositCount +
        withdrawalCount +
        expenseCount +
        transferOutCount +
        transferInCount +
        settlementInRangeCount;
      const closingBalance =
        openingBalance +
        deposit +
        transferIn -
        withdrawal -
        expenses -
        transferOut +
        settlementInRange;

      return {
        bankId,
        name: `${String(bank.holderName ?? "").trim()} ${String(bank.bankName ?? "").trim()}`.trim() || "Unknown",
        holderName: String(bank.holderName ?? ""),
        bankName: String(bank.bankName ?? ""),
        openingBalance,
        entries,
        depositCount,
        withdrawalCount,
        expenseCount,
        transferOutCount,
        transferInCount,
        deposit,
        withdrawal,
        expenses,
        transferOut,
        transferIn,
        closingBalance,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    meta: {
      fromDate: appliedRange.fromDate,
      toDate: appliedRange.toDate,
      exchangeId: query.exchangeId ?? null,
      status: query.status ?? "all",
      transactionType: query.transactionType ?? "all",
      scopedPlayerCount: scopedPlayerIds?.length ?? null,
      todayYmdIst: todayRange.ymd,
    },
    deposit: {
      totalAmount: depositTotal,
      totalCount: depositCount,
      pendingCount: depositPendingCount,
      pendingAmount: depositPendingAmount,
      verifiedAmount: depositVerifiedAmount,
      verifiedCount: depositVerifiedCount,
      rejectedCount: depositRejectedCount,
      bonusTotal,
    },
    withdrawal: {
      totalAmount: withdrawalTotal,
      totalCount: withdrawalCount,
      pendingCount: withdrawalPendingCount,
      pendingAmount: withdrawalPendingAmount,
      approvedAmount: withdrawalApprovedAmount,
      approvedCount: withdrawalApprovedCount,
      rejectedCount: withdrawalRejectedCount,
      reverseBonusTotal,
    },
    expense: {
      totalAmount: expenseTotal,
      totalCount: expenseCount,
      pendingCount: expensePendingCount,
      approvedAmount: expenseApprovedAmount,
    },
    pnl: {
      gross: grossPL,
      net: netPL,
    },
    exchanges: {
      total: exchangeTotal,
      active: exchangeActive,
    },
    users: {
      total: totalUsers,
    },
    periodMetrics: {
      newPlayers: periodNewPlayersCount ?? 0,
      firstTimeDepositAmount,
    },
    trendData,
    recentActivity,
    exchangesBreakdown: exchangesBreakdownWithBalances,
    banksBreakdown,
  };
}

export async function getTransactionHistory(
  query: TransactionHistoryQuery,
  options: { scope: AuditHistoryScope; timeZone?: string },
) {
  const timeZone = options.timeZone || DEFAULT_TIMEZONE;
  const dateFilter = buildDateFilter(query, timeZone);
  const conditions: Record<string, unknown>[] = [];

  if (options.scope === "transactions") {
    conditions.push({ entity: { $ne: AUDIT_ENTITY_AUTH } });
  } else {
    conditions.push({ entity: AUDIT_ENTITY_AUTH });
  }

  if (Object.keys(dateFilter).length > 0) {
    conditions.push(dateFilter);
  }

  if (query.search) {
    const esc = escapeRegexFragment(query.search);
    const searchOr: Record<string, unknown>[] = [
      { action: { $regex: esc, $options: "i" } },
      { entity: { $regex: esc, $options: "i" } },
      { entityId: { $regex: esc, $options: "i" } },
      { reason: { $regex: esc, $options: "i" } },
      { ipAddress: { $regex: esc, $options: "i" } },
    ];
    if (options.scope === "transactions") {
      searchOr.splice(3, 0, { requestId: { $regex: esc, $options: "i" } });
    }
    conditions.push({ $or: searchOr });
  }

  if (options.scope === "transactions" && query.entity) {
    conditions.push({ entity: query.entity.trim() });
  }
  if (query.action) {
    conditions.push({ action: { $regex: escapeRegexFragment(query.action), $options: "i" } });
  }
  if (query.actorId && Types.ObjectId.isValid(query.actorId)) {
    conditions.push({ actorId: new Types.ObjectId(query.actorId) });
  }

  const filter: Record<string, unknown> =
    conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0]! : { $and: conditions };

  const skip = (query.page - 1) * query.pageSize;
  const [rows, total] = await Promise.all([
    AuditLogModel.find(filter)
      .populate("actorId", "fullName username")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(query.pageSize)
      .lean(),
    AuditLogModel.countDocuments(filter),
  ]);
  return {
    rows: rows,
    meta: {
      total,
      page: query.page,
      pageSize: query.pageSize,
    },
  };
}

export async function exportTransactionHistoryToBuffer(
  query: TransactionHistoryQuery,
  options: { scope: AuditHistoryScope; timeZone?: string },
): Promise<Buffer> {
  const result = await getTransactionHistory(
    { ...query, page: 1, pageSize: 10000 },
    options,
  );

  const exportData = result.rows.map((r: any) => ({
    Date: formatDateTimeForTimeZone(r.createdAt, options.timeZone || DEFAULT_TIMEZONE),
    Actor: r.actorId?.fullName || r.actorId?.username || r.actorId || "System",
    Action: r.action || "",
    Entity: r.entity || "",
    "Entity ID": r.entityId || "",
    "Request ID": r.requestId || "",
    IP: r.ipAddress || "",
    Reason: r.reason || "",
  }));

  return generateExcelBuffer(
    exportData,
    [
      { header: "Date", key: "Date" },
      { header: "Actor", key: "Actor" },
      { header: "Action", key: "Action" },
      { header: "Entity", key: "Entity" },
      { header: "Entity ID", key: "Entity ID" },
      { header: "Request ID", key: "Request ID" },
      { header: "IP", key: "IP" },
      { header: "Reason", key: "Reason" },
    ],
    options.scope === "transactions" ? "Audit History" : "Login History",
  );
}

export async function exportDashboardSummaryToBuffer(
  query: DashboardSummaryQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const data = await getDashboardSummary(query, { timeZone });

  const kpiData = [
    { KPI: "Total Deposits", Value: data.deposit.totalAmount },
    { KPI: "Verified Deposits", Value: data.deposit.verifiedAmount },
    { KPI: "Bonus Amount", Value: data.deposit.bonusTotal },
    { KPI: "Total Withdrawals", Value: data.withdrawal.totalAmount },
    { KPI: "Approved Withdrawals", Value: data.withdrawal.approvedAmount },
    { KPI: "Reverse Bonus", Value: data.withdrawal.reverseBonusTotal },
    { KPI: "Total Expenses", Value: data.expense.totalAmount },
    { KPI: "Net P&L", Value: data.pnl.net },
    { KPI: "New Players (Selected Period)", Value: data.periodMetrics.newPlayers },
    { KPI: "First-Time Deposit Amount (Selected Period)", Value: data.periodMetrics.firstTimeDepositAmount },
  ];

  const exchangeData = data.exchangesBreakdown.map((ex) => ({
    Exchange: ex.name,
    Deposits: ex.depositTotal,
    Withdrawals: ex.withdrawalTotal,
    "Net P&L": ex.netPL,
    "Bonus Given": ex.bonusGiven,
    "Period Opening": ex.periodOpeningBalance ?? 0,
    "Period Closing": ex.periodClosingBalance ?? 0,
  }));

  const recentTxns = data.recentActivity.map((t) => ({
    Type: t.type,
    Date: t.createdAt,
    Player: t.playerName,
    Amount: t.amount,
    Status: t.status,
  }));

  return generateMultiSheetExcelBuffer([
    {
      name: "Operational Summary",
      data: kpiData,
      columns: [
        { header: "KPI", key: "KPI" },
        { header: "Value", key: "Value" },
      ],
    },
    {
      name: "Exchange Breakdown",
      data: exchangeData,
      columns: [
        { header: "Exchange", key: "Exchange" },
        { header: "Deposits", key: "Deposits" },
        { header: "Withdrawals", key: "Withdrawals" },
        { header: "Net P&L", key: "Net P&L" },
        { header: "Bonus Given", key: "Bonus Given" },
        { header: "Period Opening", key: "Period Opening" },
        { header: "Period Closing", key: "Period Closing" },
      ],
    },
    {
      name: "Recent Activity",
      data: recentTxns,
      columns: [
        { header: "Type", key: "Type" },
        { header: "Date", key: "Date" },
        { header: "Player", key: "Player" },
        { header: "Amount", key: "Amount" },
        { header: "Status", key: "Status" },
      ],
    },
  ]);
}

export async function exportExpenseAnalysisToBuffer(
  query: ExpenseAnalysisRecordsQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const result = await getExpenseAnalysisRecords({
    ...query,
    page: 1,
    pageSize: 10000,
  }, { timeZone });

  const exportData = result.rows.map((r) => {
    const et = r.expenseTypeId as { name?: string } | null;
    const b = r.bankId as { holderName?: string; bankName?: string } | null;
    const p = r.liabilityPersonId as { name?: string } | null;
    let settlement = r.bankName ?? "";
    if (r.settlementAccountType === "person" && p?.name) {
      settlement = `Person: ${p.name}`;
    } else if (r.settlementAccountType === "bank" && b) {
      settlement = `${b.holderName ?? ""} — ${b.bankName ?? ""}`.trim();
    }

    return {
      "Expense Date": formatDateForTimeZone(r.expenseDate, timeZone),
      Category: et?.name ?? "",
      Amount: r.amount,
      Status: r.status,
      Settlement: settlement,
      Description: r.description ?? "",
      "Reject Reason": r.rejectReason ?? "",
      "Cancel Reason": r.cancelReason ?? "",
      "Created By": formatUserLabelForExport(r.createdBy),
      "Approved By": formatUserLabelForExport(r.approvedBy),
      "Cancelled By": formatUserLabelForExport(r.cancelledBy),
    };
  });

  return generateExcelBuffer(
    exportData,
    [
      { header: "Expense Date", key: "Expense Date" },
      { header: "Category", key: "Category" },
      { header: "Amount", key: "Amount" },
      { header: "Status", key: "Status" },
      { header: "Settlement", key: "Settlement" },
      { header: "Description", key: "Description" },
      { header: "Reject Reason", key: "Reject Reason" },
      { header: "Cancel Reason", key: "Cancel Reason" },
      { header: "Created By", key: "Created By" },
      { header: "Approved By", key: "Approved By" },
      { header: "Cancelled By", key: "Cancelled By" },
    ],
    "Expense Analysis",
  );
}

function formatUserLabelForExport(user: unknown): string {
  if (user == null) return "";
  if (typeof user === "object" && user !== null && "fullName" in user) {
    const u = user as { fullName?: string; username?: string };
    const fn = u.fullName?.trim();
    const un = u.username?.trim();
    if (fn && un) return `${fn} (${un})`;
    if (fn) return fn;
    if (un) return un;
  }
  return "";
}

/** Distinct non-auth entity values for transaction history filters. */
export async function listAuditEntityValuesForTransactions(): Promise<string[]> {
  const distinct = (await AuditLogModel.distinct("entity", {
    entity: { $ne: AUDIT_ENTITY_AUTH },
  })) as string[];
  return Array.from(
    new Set(distinct.map((e) => String(e).trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));
}

/** Login history page only ever filters `auth`. */
export function listAuditEntityValuesForLogin(): string[] {
  return [AUDIT_ENTITY_AUTH];
}

function trimUndef(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t === "" ? undefined : t;
}

/** Mirrors expense list `expenseDateCondition` / `createdAt` range (same semantics as expense.service). */
function dateFieldCondition(
  field: "expenseDate" | "createdAt",
  from: string | undefined,
  to: string | undefined,
  op: string | undefined,
  timeZone: string,
): Record<string, unknown> | null {
  const f = trimUndef(from);
  const t = trimUndef(to);
  const rawOp = trimUndef(op);
  const effectiveOp = rawOp || (f && t ? "inRange" : f || t ? "equals" : "");

  if (effectiveOp === "inRange" && f && t) {
    const start = ymdToUtcStartInZone(f, timeZone);
    const end = ymdToUtcEndInZone(t, timeZone);
    if (!start || !end) return null;
    return { [field]: { $gte: start, $lte: end } };
  }
  if (effectiveOp === "equals" && f) {
    const start = ymdToUtcStartInZone(f, timeZone);
    const end = ymdToUtcEndInZone(f, timeZone);
    if (!start || !end) return null;
    return { [field]: { $gte: start, $lte: end } };
  }
  if (effectiveOp === "before" && f) {
    const start = ymdToUtcStartInZone(f, timeZone);
    if (!start) return null;
    return { [field]: { $lt: start } };
  }
  if (effectiveOp === "after" && f) {
    const end = ymdToUtcEndInZone(f, timeZone);
    if (!end) return null;
    return { [field]: { $gt: end } };
  }
  if (f && t) {
    const start = ymdToUtcStartInZone(f, timeZone);
    const end = ymdToUtcEndInZone(t, timeZone);
    if (!start || !end) return null;
    return { [field]: { $gte: start, $lte: end } };
  }
  if (f) {
    const start = ymdToUtcStartInZone(f, timeZone);
    if (!start) return null;
    return { [field]: { $gte: start } };
  }
  if (t) {
    const end = ymdToUtcEndInZone(t, timeZone);
    if (!end) return null;
    return { [field]: { $lte: end } };
  }
  return null;
}

function parseNum(s: string | undefined): number | null {
  if (s == null) return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function amountCondition(
  raw: string | undefined,
  rawTo: string | undefined,
  op: string | undefined,
): Record<string, unknown> | null {
  const a = trimUndef(raw);
  const b = trimUndef(rawTo);
  const rawOp = trimUndef(op);
  const effectiveOp = rawOp || (a && b ? "between" : a ? "equals" : "");

  if (!a && !b) return null;

  if (effectiveOp === "between" && a && b) {
    const x = parseNum(a);
    const y = parseNum(b);
    if (x == null || y == null) return null;
    return { amount: { $gte: Math.min(x, y), $lte: Math.max(x, y) } };
  }
  if (effectiveOp === "equals" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: x };
  }
  if (effectiveOp === "notEquals" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: { $ne: x } };
  }
  if (effectiveOp === "gt" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: { $gt: x } };
  }
  if (effectiveOp === "gte" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: { $gte: x } };
  }
  if (effectiveOp === "lt" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: { $lt: x } };
  }
  if (effectiveOp === "lte" && a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: { $lte: x } };
  }
  if (a && b) {
    const x = parseNum(a);
    const y = parseNum(b);
    if (x == null || y == null) return null;
    return { amount: { $gte: Math.min(x, y), $lte: Math.max(x, y) } };
  }
  if (a) {
    const x = parseNum(a);
    if (x == null) return null;
    return { amount: x };
  }
  return null;
}

export function buildExpenseReportFilter(
  q: ExpenseAnalysisFilterQuery,
  options?: { timeZone?: string },
): Record<string, unknown> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const conditions: Record<string, unknown>[] = [];

  const search = trimUndef(q.search);
  if (search) {
    const esc = escapeRegexFragment(search);
    conditions.push({
      $or: [
        { description: { $regex: esc, $options: "i" } },
        { bankName: { $regex: esc, $options: "i" } },
        { rejectReason: { $regex: esc, $options: "i" } },
        { cancelReason: { $regex: esc, $options: "i" } },
      ],
    });
  }

  const st = trimUndef(q.status);
  if (st === "pending_audit" || st === "approved" || st === "rejected" || st === "cancelled") {
    conditions.push({ status: st as ExpenseStatus });
  } else {
    conditions.push({
      status: { $in: ["pending_audit", "approved", "rejected", "cancelled"] as ExpenseStatus[] },
    });
  }

  const expenseTypeId = trimUndef(q.expenseTypeId);
  if (expenseTypeId && Types.ObjectId.isValid(expenseTypeId)) {
    conditions.push({ expenseTypeId: new Types.ObjectId(expenseTypeId) });
  }

  const bankId = trimUndef(q.bankId);
  if (bankId && Types.ObjectId.isValid(bankId)) {
    conditions.push({ bankId: new Types.ObjectId(bankId) });
  }

  const expenseDateCond = dateFieldCondition(
    "expenseDate",
    trimUndef(q.expenseDate_from),
    trimUndef(q.expenseDate_to),
    trimUndef(q.expenseDate_op),
    timeZone,
  );
  if (expenseDateCond) conditions.push(expenseDateCond);

  const createdAtCond = dateFieldCondition(
    "createdAt",
    trimUndef(q.createdAt_from),
    trimUndef(q.createdAt_to),
    trimUndef(q.createdAt_op),
    timeZone,
  );
  if (createdAtCond) conditions.push(createdAtCond);

  const amtCond = amountCondition(trimUndef(q.amount), trimUndef(q.amount_to), trimUndef(q.amount_op));
  if (amtCond) conditions.push(amtCond);

  const createdBy = trimUndef(q.createdBy);
  if (createdBy && Types.ObjectId.isValid(createdBy)) {
    conditions.push({ createdBy: new Types.ObjectId(createdBy) });
  }

  const approvedBy = trimUndef(q.approvedBy);
  if (approvedBy && Types.ObjectId.isValid(approvedBy)) {
    conditions.push({ approvedBy: new Types.ObjectId(approvedBy) });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0]!;
  return { $and: conditions };
}

function expenseAnalysisStatusTotals(
  byStatus: Array<{ status: string; totalAmount: number; count: number }>,
): {
  netApprovedTotal: number;
  netApprovedCount: number;
  cancelledTotal: number;
  cancelledCount: number;
  pendingTotal: number;
  pendingCount: number;
  rejectedTotal: number;
  rejectedCount: number;
} {
  const pick = (status: string) =>
    byStatus.find((r) => r.status === status) ?? { totalAmount: 0, count: 0 };
  const approved = pick("approved");
  const cancelled = pick("cancelled");
  const pending = pick("pending_audit");
  const rejected = pick("rejected");
  return {
    netApprovedTotal: approved.totalAmount,
    netApprovedCount: approved.count,
    cancelledTotal: cancelled.totalAmount,
    cancelledCount: cancelled.count,
    pendingTotal: pending.totalAmount,
    pendingCount: pending.count,
    rejectedTotal: rejected.totalAmount,
    rejectedCount: rejected.count,
  };
}

export async function getExpenseAnalysisSummary(
  query: ExpenseAnalysisFilterQuery,
  options?: { timeZone?: string },
) {
  const filter = buildExpenseReportFilter(query, options);
  const statusFilter = trimUndef(query.status);

  const chartStatus =
    statusFilter === "pending_audit" ||
    statusFilter === "approved" ||
    statusFilter === "rejected" ||
    statusFilter === "cancelled"
      ? statusFilter
      : "approved";

  const [facetAgg] = await ExpenseModel.aggregate([
    { $match: filter },
    {
      $facet: {
        byStatus: [
          {
            $group: {
              _id: "$status",
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              status: "$_id",
              totalAmount: 1,
              count: 1,
            },
          },
        ],
        byExpenseType: [
          { $match: { status: chartStatus } },
          {
            $group: {
              _id: "$expenseTypeId",
              totalAmount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          {
            $lookup: {
              from: "expensetypes",
              localField: "_id",
              foreignField: "_id",
              as: "et",
            },
          },
          {
            $project: {
              expenseTypeId: "$_id",
              name: { $arrayElemAt: ["$et.name", 0] },
              totalAmount: 1,
              count: 1,
            },
          },
          { $sort: { name: 1 } },
        ],
      },
    },
  ]);

  const byStatusRaw = (facetAgg?.byStatus ?? []) as Array<{
    status: string;
    totalAmount: number;
    count: number;
  }>;
  const byStatus = byStatusRaw.map((r) => ({
    status: String(r.status ?? ""),
    totalAmount: r.totalAmount ?? 0,
    count: r.count ?? 0,
  }));

  const statusTotals = expenseAnalysisStatusTotals(byStatus);
  const totalCount = byStatus.reduce((sum, r) => sum + r.count, 0);

  let grandTotal: number;
  if (statusFilter === "pending_audit" || statusFilter === "approved" || statusFilter === "rejected" || statusFilter === "cancelled") {
    grandTotal = byStatus.find((r) => r.status === statusFilter)?.totalAmount ?? 0;
  } else {
    grandTotal = statusTotals.netApprovedTotal;
  }

  const summaryAgg = (facetAgg?.byExpenseType ?? []) as Array<{
    expenseTypeId?: { toString?: () => string };
    _id?: unknown;
    name?: string;
    totalAmount?: number;
    count?: number;
  }>;

  return {
    grandTotal,
    totalCount,
    ...statusTotals,
    byStatus,
    byExpenseType: summaryAgg.map((r) => ({
      expenseTypeId: r.expenseTypeId?.toString?.() ?? String(r._id ?? ""),
      name: r.name ?? "",
      totalAmount: r.totalAmount ?? 0,
      count: r.count ?? 0,
    })),
  };
}

export async function getExpenseAnalysisRecords(
  query: ExpenseAnalysisRecordsQuery,
  options?: { timeZone?: string },
) {
  const filter = buildExpenseReportFilter(query, options);
  const page = query.page;
  const pageSize = query.pageSize;
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    ExpenseModel.find(filter)
      .populate("expenseTypeId", "name code")
      .populate("bankId", "holderName bankName accountNumber")
      .populate("liabilityPersonId", "name")
      .populate("createdBy", "fullName username")
      .populate("approvedBy", "fullName username")
      .populate("cancelledBy", "fullName username")
      .sort({ [query.sortBy]: sortValue })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    ExpenseModel.countDocuments(filter),
  ]);

  return {
    rows,
    meta: { page, pageSize, total },
  };
}
