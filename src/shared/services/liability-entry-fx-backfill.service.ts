import { Types } from "mongoose";
import { LiabilityEntryModel } from "../../modules/liability/liability-entry.model";
import { ExpenseModel } from "../../modules/expense/expense.model";
import { DepositModel } from "../../modules/deposit/deposit.model";
import { WithdrawalModel } from "../../modules/withdrawal/withdrawal.model";
import { requirePlatformCurrency } from "../../modules/settings/settings.service";
import {
  moneyFxSnapshotForPlatformAmount,
  moneyFxSnapshotFromDoc,
  type MoneyFxSnapshot,
} from "../utils/moneyFx";

export type LiabilityEntryFxBackfillOptions = {
  dryRun: boolean;
};

type SourceKind = "expense" | "deposit" | "withdrawal";

export type LiabilityEntryFxUpdatePlan = {
  entryId: string;
  sourceType: SourceKind;
  sourceId: string;
  from: { operatedCurrency?: string; operatedAmount?: number; exchangeRate?: number };
  to: MoneyFxSnapshot;
};

export type LiabilityEntryFxBackfillSummary = {
  mode: "dry-run" | "apply";
  scanned: number;
  planned: number;
  modified: number;
  bySource: Record<SourceKind, { scanned: number; planned: number; modified: number }>;
  samples: LiabilityEntryFxUpdatePlan[];
  elapsedMs: number;
};

function isPlatformDefaultFx(
  entry: {
    operatedCurrency?: string | null;
    operatedAmount?: number | null;
    exchangeRate?: number | null;
    amount: number;
  },
  platformCurrency: string,
): boolean {
  const currency = entry.operatedCurrency?.trim().toUpperCase();
  if (!currency) return true;
  if (currency !== platformCurrency) return false;
  const rate = entry.exchangeRate != null ? Number(entry.exchangeRate) : 1;
  const operated = entry.operatedAmount != null ? Number(entry.operatedAmount) : entry.amount;
  return (
    (!Number.isFinite(rate) || Math.abs(rate - 1) < 1e-12) &&
    Number.isFinite(operated) &&
    Math.abs(operated - entry.amount) < 1e-6
  );
}

function sourceHasRealFx(
  snapshot: MoneyFxSnapshot | undefined,
  platformCurrency: string,
): snapshot is MoneyFxSnapshot {
  if (!snapshot) return false;
  if (snapshot.operatedCurrency !== platformCurrency) return true;
  return Math.abs(snapshot.exchangeRate - 1) > 1e-12;
}

async function planUpdates(platformCurrency: string): Promise<LiabilityEntryFxUpdatePlan[]> {
  const plans: LiabilityEntryFxUpdatePlan[] = [];

  const expenseEntries = await LiabilityEntryModel.find({
    sourceType: "expense",
    sourceExpenseId: { $exists: true, $ne: null },
  })
    .select("_id amount operatedCurrency operatedAmount exchangeRate sourceExpenseId sourceType")
    .lean();

  const expenseIds = expenseEntries
    .map((e) => e.sourceExpenseId)
    .filter((id): id is Types.ObjectId => Boolean(id));
  const expenses = await ExpenseModel.find({ _id: { $in: expenseIds } })
    .select("_id amount operatedCurrency operatedAmount exchangeRate")
    .lean();
  const expenseMap = new Map(expenses.map((d) => [String(d._id), d]));

  for (const entry of expenseEntries) {
    const source = expenseMap.get(String(entry.sourceExpenseId));
    if (!source) continue;
    if (!isPlatformDefaultFx(entry, platformCurrency)) continue;
    const snap = moneyFxSnapshotFromDoc(source);
    if (!sourceHasRealFx(snap, platformCurrency)) continue;
    plans.push({
      entryId: String(entry._id),
      sourceType: "expense",
      sourceId: String(source._id),
      from: {
        operatedCurrency: entry.operatedCurrency,
        operatedAmount: entry.operatedAmount,
        exchangeRate: entry.exchangeRate,
      },
      to: snap,
    });
  }

  const depositEntries = await LiabilityEntryModel.find({
    sourceType: "deposit",
    sourceDepositId: { $exists: true, $ne: null },
  })
    .select("_id amount operatedCurrency operatedAmount exchangeRate sourceDepositId sourceType")
    .lean();

  const depositIds = depositEntries
    .map((e) => e.sourceDepositId)
    .filter((id): id is Types.ObjectId => Boolean(id));
  const deposits = await DepositModel.find({ _id: { $in: depositIds } })
    .select("_id amount operatedCurrency operatedAmount exchangeRate")
    .lean();
  const depositMap = new Map(deposits.map((d) => [String(d._id), d]));

  for (const entry of depositEntries) {
    const source = depositMap.get(String(entry.sourceDepositId));
    if (!source) continue;
    if (!isPlatformDefaultFx(entry, platformCurrency)) continue;
    const snap = moneyFxSnapshotFromDoc(source);
    if (!sourceHasRealFx(snap, platformCurrency)) continue;
    plans.push({
      entryId: String(entry._id),
      sourceType: "deposit",
      sourceId: String(source._id),
      from: {
        operatedCurrency: entry.operatedCurrency,
        operatedAmount: entry.operatedAmount,
        exchangeRate: entry.exchangeRate,
      },
      to: snap,
    });
  }

  const withdrawalEntries = await LiabilityEntryModel.find({
    sourceType: "withdrawal",
    sourceWithdrawalId: { $exists: true, $ne: null },
  })
    .select("_id amount operatedCurrency operatedAmount exchangeRate sourceWithdrawalId sourceType")
    .lean();

  const withdrawalIds = withdrawalEntries
    .map((e) => e.sourceWithdrawalId)
    .filter((id): id is Types.ObjectId => Boolean(id));
  const withdrawals = await WithdrawalModel.find({ _id: { $in: withdrawalIds } })
    .select("_id amount payableAmount operatedCurrency operatedAmount exchangeRate")
    .lean();
  const withdrawalMap = new Map(withdrawals.map((d) => [String(d._id), d]));

  for (const entry of withdrawalEntries) {
    const source = withdrawalMap.get(String(entry.sourceWithdrawalId));
    if (!source) continue;
    if (!isPlatformDefaultFx(entry, platformCurrency)) continue;
    const snap = moneyFxSnapshotForPlatformAmount(source, Number(entry.amount));
    if (!sourceHasRealFx(snap, platformCurrency)) continue;
    plans.push({
      entryId: String(entry._id),
      sourceType: "withdrawal",
      sourceId: String(source._id),
      from: {
        operatedCurrency: entry.operatedCurrency,
        operatedAmount: entry.operatedAmount,
        exchangeRate: entry.exchangeRate,
      },
      to: snap,
    });
  }

  return plans;
}

/**
 * Copy operated FX from source expense/deposit/withdrawal onto liability entries
 * that still store platform-default FX (platform currency + rate ~1).
 * Idempotent: already-corrected rows are skipped.
 */
export async function runBackfillLiabilityEntryFx(
  options: LiabilityEntryFxBackfillOptions,
): Promise<LiabilityEntryFxBackfillSummary> {
  const startedAt = Date.now();
  const platformCurrency = await requirePlatformCurrency();
  const plans = await planUpdates(platformCurrency);

  const bySource: LiabilityEntryFxBackfillSummary["bySource"] = {
    expense: { scanned: 0, planned: 0, modified: 0 },
    deposit: { scanned: 0, planned: 0, modified: 0 },
    withdrawal: { scanned: 0, planned: 0, modified: 0 },
  };

  const scannedExpense = await LiabilityEntryModel.countDocuments({ sourceType: "expense" });
  const scannedDeposit = await LiabilityEntryModel.countDocuments({ sourceType: "deposit" });
  const scannedWithdrawal = await LiabilityEntryModel.countDocuments({ sourceType: "withdrawal" });
  bySource.expense.scanned = scannedExpense;
  bySource.deposit.scanned = scannedDeposit;
  bySource.withdrawal.scanned = scannedWithdrawal;

  for (const plan of plans) {
    bySource[plan.sourceType].planned += 1;
  }

  let modified = 0;
  if (!options.dryRun) {
    for (const plan of plans) {
      const result = await LiabilityEntryModel.updateOne(
        { _id: new Types.ObjectId(plan.entryId) },
        {
          $set: {
            operatedCurrency: plan.to.operatedCurrency,
            operatedAmount: plan.to.operatedAmount,
            exchangeRate: plan.to.exchangeRate,
          },
        },
      );
      if ((result.modifiedCount ?? 0) > 0) {
        modified += 1;
        bySource[plan.sourceType].modified += 1;
      }
    }
  }

  return {
    mode: options.dryRun ? "dry-run" : "apply",
    scanned: scannedExpense + scannedDeposit + scannedWithdrawal,
    planned: plans.length,
    modified,
    bySource,
    samples: plans.slice(0, 20),
    elapsedMs: Date.now() - startedAt,
  };
}
