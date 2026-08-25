import { Types } from "mongoose";
import { DepositModel } from "../../modules/deposit/deposit.model";
import { ExchangeModel } from "../../modules/exchange/exchange.model";
import { ExchangeTopupModel } from "../../modules/exchange-topup/exchange-topup.model";
import { WithdrawalModel } from "../../modules/withdrawal/withdrawal.model";

function toAmountMap(rows: Array<{ _id: Types.ObjectId; totalAmount?: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(String(row._id), Number(row.totalAmount ?? 0));
  return out;
}

/**
 * All-time running exchange balance per exchange:
 * openingBalance - verified/finalized deposits + approved/finalized withdrawals + topups.
 * Deposits/withdrawals are attributed via player → exchange ($lookup), matching dashboard period balances.
 */
export async function computeAllTimeExchangeBalances(
  exchangeIds: Types.ObjectId[],
): Promise<Map<string, number>> {
  const balanceMap = new Map<string, number>();
  if (exchangeIds.length === 0) return balanceMap;

  const exchanges = await ExchangeModel.find({ _id: { $in: exchangeIds } })
    .select({ _id: 1, openingBalance: 1 })
    .lean();
  if (exchanges.length === 0) return balanceMap;

  const [depositTotals, withdrawalTotals, topupTotals] = await Promise.all([
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
      {
        $group: {
          _id: "$playerDoc.exchange",
          totalAmount: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
        },
      },
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
      {
        $group: {
          _id: "$playerDoc.exchange",
          totalAmount: { $sum: { $ifNull: ["$payableAmount", "$amount"] } },
        },
      },
    ]),
    ExchangeTopupModel.aggregate<{ _id: Types.ObjectId; totalAmount: number }>([
      { $match: { exchangeId: { $in: exchangeIds } } },
      { $group: { _id: "$exchangeId", totalAmount: { $sum: "$amount" } } },
    ]),
  ]);

  const depositMap = toAmountMap(depositTotals);
  const withdrawalMap = toAmountMap(withdrawalTotals);
  const topupMap = toAmountMap(topupTotals);

  for (const row of exchanges) {
    const exchangeId = String(row._id);
    const openingBase = Number(row.openingBalance ?? 0);
    const currentBalance =
      openingBase -
      Number(depositMap.get(exchangeId) ?? 0) +
      Number(withdrawalMap.get(exchangeId) ?? 0) +
      Number(topupMap.get(exchangeId) ?? 0);
    balanceMap.set(exchangeId, currentBalance);
  }

  return balanceMap;
}

const BALANCE_EPSILON = 0.000001;
const BULK_BATCH_SIZE = 500;

export type SyncExchangeBalancesResult = {
  total: number;
  updated: number;
  unchanged: number;
};

export type SyncExchangeBalanceRow = {
  exchangeId: string;
  name: string;
  provider: string;
  previousCurrentBalance: number;
  computedCurrentBalance: number;
  delta: number;
  changed: boolean;
};

function balanceChanged(previous: number, computed: number): boolean {
  return Math.abs(computed - previous) > BALANCE_EPSILON;
}

export async function planAllExchangeCurrentBalanceSync(): Promise<SyncExchangeBalanceRow[]> {
  const exchanges = await ExchangeModel.find({})
    .select({ _id: 1, name: 1, provider: 1, openingBalance: 1, currentBalance: 1 })
    .lean();
  if (exchanges.length === 0) return [];

  const exchangeIds = exchanges.map((row) => row._id);
  const computedById = await computeAllTimeExchangeBalances(exchangeIds);

  return exchanges.map((row) => {
    const exchangeId = String(row._id);
    const previousCurrentBalance = Number(row.currentBalance ?? row.openingBalance ?? 0);
    const computedCurrentBalance = Number(computedById.get(exchangeId) ?? row.openingBalance ?? 0);
    const delta = computedCurrentBalance - previousCurrentBalance;
    return {
      exchangeId,
      name: row.name,
      provider: row.provider,
      previousCurrentBalance,
      computedCurrentBalance,
      delta,
      changed: balanceChanged(previousCurrentBalance, computedCurrentBalance),
    };
  });
}

/**
 * Recompute and persist currentBalance for all exchanges (only rows that differ).
 * Set apply=false for dry-run counts without writing.
 */
export async function syncAllExchangeCurrentBalances(options?: {
  apply?: boolean;
}): Promise<SyncExchangeBalancesResult> {
  const apply = options?.apply ?? true;
  const plan = await planAllExchangeCurrentBalanceSync();
  const total = plan.length;
  const changedRows = plan.filter((row) => row.changed);

  if (!apply || changedRows.length === 0) {
    return {
      total,
      updated: 0,
      unchanged: total - changedRows.length,
    };
  }

  let updated = 0;
  for (let i = 0; i < changedRows.length; i += BULK_BATCH_SIZE) {
    const batch = changedRows.slice(i, i + BULK_BATCH_SIZE);
    const result = await ExchangeModel.bulkWrite(
      batch.map((row) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(row.exchangeId) },
          update: { $set: { currentBalance: row.computedCurrentBalance } },
        },
      })),
    );
    updated += result.modifiedCount ?? 0;
  }

  return {
    total,
    updated,
    unchanged: total - changedRows.length,
  };
}
