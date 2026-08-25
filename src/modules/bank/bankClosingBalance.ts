import { Types } from "mongoose";
import { BankModel } from "./bank.model";
import { BankBalanceSettlementModel } from "./bank-balance-settlement.model";
import { DepositModel } from "../deposit/deposit.model";
import { WithdrawalModel } from "../withdrawal/withdrawal.model";
import { ExpenseModel } from "../expense/expense.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { ReferralAccrualModel } from "../referral/referral-accrual.model";

/**
 * Statement-equivalent closing per bank:
 * openingBalance + verified deposits - approved withdrawals - approved expenses
 * - bank-funded IB referral settles +/- liabilities + master settlements.
 */
export async function computeClosingBalanceActualByBankIds(
  bankIds: Types.ObjectId[],
): Promise<Map<string, number>> {
  if (bankIds.length === 0) return new Map();
  const [banks, deposits, withdrawals, expenses, referralSettles, liabilities, settlements] = await Promise.all([
    BankModel.find({ _id: { $in: bankIds } })
      .select({ _id: 1, openingBalance: 1 })
      .lean(),
    DepositModel.find({ bankId: { $in: bankIds }, status: "verified" })
      .select({ bankId: 1, amount: 1 })
      .lean(),
    WithdrawalModel.find({ payoutBankId: { $in: bankIds }, status: "approved" })
      .select({ payoutBankId: 1, amount: 1, payableAmount: 1 })
      .lean(),
    ExpenseModel.find({ bankId: { $in: bankIds }, status: "approved" })
      .select({ bankId: 1, amount: 1 })
      .lean(),
    ReferralAccrualModel.find({
      bankId: { $in: bankIds },
      status: "settled",
      settlementAccountType: "bank",
    })
      .select({ bankId: 1, accruedAmount: 1 })
      .lean(),
    LiabilityEntryModel.find({
      $or: [
        { fromAccountType: "bank", fromAccountId: { $in: bankIds } },
        { toAccountType: "bank", toAccountId: { $in: bankIds } },
      ],
    })
      .select({ fromAccountType: 1, fromAccountId: 1, toAccountType: 1, toAccountId: 1, amount: 1 })
      .lean(),
    BankBalanceSettlementModel.find({ bankId: { $in: bankIds } })
      .select({ bankId: 1, signedAmount: 1 })
      .lean(),
  ]);

  const totals = new Map<string, number>();
  for (const b of banks) {
    totals.set(String(b._id), Number(b.openingBalance ?? 0));
  }

  for (const d of deposits) {
    const id = String(d.bankId);
    const prev = totals.get(id) ?? 0;
    totals.set(id, prev + Number(d.amount ?? 0));
  }
  for (const w of withdrawals) {
    const id = String(w.payoutBankId);
    const prev = totals.get(id) ?? 0;
    totals.set(id, prev - Number(w.payableAmount ?? w.amount ?? 0));
  }
  for (const e of expenses) {
    const id = String(e.bankId);
    const prev = totals.get(id) ?? 0;
    totals.set(id, prev - Number(e.amount ?? 0));
  }
  for (const r of referralSettles) {
    const id = String(r.bankId);
    const prev = totals.get(id) ?? 0;
    totals.set(id, prev - Number(r.accruedAmount ?? 0));
  }
  for (const le of liabilities) {
    const amt = Number(le.amount ?? 0);
    if (le.fromAccountType === "bank" && le.fromAccountId) {
      const id = String(le.fromAccountId);
      const prev = totals.get(id) ?? 0;
      totals.set(id, prev - amt);
    }
    if (le.toAccountType === "bank" && le.toAccountId) {
      const id = String(le.toAccountId);
      const prev = totals.get(id) ?? 0;
      totals.set(id, prev + amt);
    }
  }
  for (const s of settlements) {
    const id = String(s.bankId);
    const prev = totals.get(id) ?? 0;
    totals.set(id, prev + Number(s.signedAmount ?? 0));
  }
  return totals;
}
