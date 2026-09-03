import { Types } from "mongoose";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import type { z } from "zod";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { BankModel } from "../bank/bank.model";
import { DepositModel } from "../deposit/deposit.model";
import { ExpenseModel } from "../expense/expense.model";
import { WithdrawalModel } from "../withdrawal/withdrawal.model";
import { ReferralAccrualModel } from "../referral/referral-accrual.model";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  formatDateTimeForTimeZone,
  ymdToUtcEnd,
  ymdToUtcNoon,
  ymdToUtcStart,
} from "../../shared/utils/timezone";
import { type LiabilityEntryDocument, LiabilityEntryModel } from "./liability-entry.model";
import { LiabilityPersonModel } from "./liability-person.model";
import {
  exportLiabilityEntryQuerySchema,
  exportLiabilityPersonQuerySchema,
  liabilityLedgerQuerySchema,
  listLiabilityEntryQuerySchema,
  listLiabilityPersonQuerySchema,
} from "./liability.validation";
import { resolveMoneyFromRequest, resolveOpeningMoneyFromRequest } from "../../shared/utils/moneyFx";
import { getCurrencyMinUnit } from "../../shared/constants/currencies";
import { requirePlatformCurrency } from "../settings/settings.service";

type ListLiabilityPersonQuery = z.infer<typeof listLiabilityPersonQuerySchema>;
type ExportLiabilityPersonQuery = z.infer<typeof exportLiabilityPersonQuerySchema>;
type ListLiabilityEntryQuery = z.infer<typeof listLiabilityEntryQuerySchema>;
type ExportLiabilityEntryQuery = z.infer<typeof exportLiabilityEntryQuerySchema>;
type LedgerQuery = z.infer<typeof liabilityLedgerQuerySchema>;
type LiabilityViewMode = "platform" | "person";

const EXPORT_MAX_ROWS = 10_000;

function pageSizeFromQuery(q: { pageSize: number; limit?: number }): number {
  return q.limit ?? q.pageSize;
}

function trimUndef(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t === "" ? undefined : t;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseYmdToDate(ymd: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  return ymdToUtcNoon(ymd, timeZone) ?? new Date(ymd);
}

function resolveSideFromBalance(balance: number): "receivable" | "payable" | "settled" {
  if (balance === 0) return "settled";
  return balance > 0 ? "receivable" : "payable";
}

function normalizeViewMode(viewMode?: string): LiabilityViewMode {
  return viewMode === "person" ? "person" : "platform";
}

function resolveBalanceByViewMode(input: { openingBalance?: number; totalDebits?: number; totalCredits?: number }, viewMode: LiabilityViewMode): number {
  const opening = Number(input.openingBalance ?? 0);
  const debits = Number(input.totalDebits ?? 0);
  const credits = Number(input.totalCredits ?? 0);
  if (viewMode === "person") {
    return opening - debits + credits;
  }
  return opening + debits - credits;
}

function resolveSignedOpeningFromPersonBody(
  input: {
    openingBalance?: number;
    openingAmount?: number;
    openingKind?: "payable" | "receivable";
  },
  mode: "create" | "update",
): number | undefined {
  if (input.openingAmount !== undefined) {
    const amt = Number(input.openingAmount);
    if (!Number.isFinite(amt) || amt < 0) throw new AppError("validation_error", "Invalid openingAmount", 400);
    if (amt === 0) return 0;
    if (input.openingKind === "receivable") return amt;
    if (input.openingKind === "payable") return -amt;
    throw new AppError("validation_error", "openingKind is required when openingAmount > 0", 400);
  }
  if (input.openingBalance !== undefined) return Number(input.openingBalance);
  return mode === "create" ? 0 : undefined;
}

function enrichPersonListRow<
  T extends { openingBalance?: number; totalDebits?: number; totalCredits?: number; closingBalance?: number },
>(row: T) {
  const opening = Number(row.openingBalance ?? 0);
  /** Master list uses platform-side closing (matches default Liability Ledger viewMode). */
  const closingBal = resolveBalanceByViewMode(
    {
      openingBalance: row.openingBalance,
      totalDebits: row.totalDebits,
      totalCredits: row.totalCredits,
    },
    "platform",
  );
  return {
    ...row,
    openingBalanceAbs: Math.abs(opening),
    openingBalanceSide: resolveSideFromBalance(opening),
    closingBalance: closingBal,
    closingBalanceAbs: Math.abs(closingBal),
    closingBalanceSide: resolveSideFromBalance(closingBal),
  };
}

export async function recomputePersonRollup(personId: string): Promise<void> {
  if (!Types.ObjectId.isValid(personId)) return;
  const pid = new Types.ObjectId(personId);
  const person = await LiabilityPersonModel.findById(pid);
  if (!person) return;

  const [creditAgg, debitAgg] = await Promise.all([
    LiabilityEntryModel.aggregate<{ total: number }>([
      {
        $match: {
          fromAccountType: "person",
          fromAccountId: pid,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
    LiabilityEntryModel.aggregate<{ total: number }>([
      {
        $match: {
          toAccountType: "person",
          toAccountId: pid,
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const totalCredits = Number(creditAgg[0]?.total ?? 0);
  const totalDebits = Number(debitAgg[0]?.total ?? 0);
  /** Person-side closing: opening − debits + credits (matches migration 003 and getLiabilityPersonLedger person viewMode). */
  const closingBalance = (person.openingBalance ?? 0) + totalCredits - totalDebits;

  person.totalCredits = totalCredits;
  person.totalDebits = totalDebits;
  person.closingBalance = closingBalance;
  await person.save();
}

export type LiabilityEntryAccountLiteral = "bank" | "person" | "expense" | "deposit" | "withdrawal" | "referral";

function validateDistinctEndpoints(input: {
  fromAccountType: LiabilityEntryAccountLiteral;
  fromAccountId: string;
  toAccountType: LiabilityEntryAccountLiteral;
  toAccountId: string;
}) {
  if (input.fromAccountType === input.toAccountType && input.fromAccountId === input.toAccountId) {
    throw new AppError("business_rule_error", "From and To account cannot be same", 400);
  }
}

async function ensureAccountExists(type: LiabilityEntryAccountLiteral, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError("validation_error", "Invalid account id", 400);
  if (type === "bank") {
    const bank = await BankModel.findById(id).lean();
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);
    return;
  }
  if (type === "expense") {
    const expense = await ExpenseModel.findById(id).select("_id").lean();
    if (!expense) throw new AppError("not_found", "Expense not found", 404);
    return;
  }
  if (type === "deposit") {
    const dep = await DepositModel.findById(id).select("_id").lean();
    if (!dep) throw new AppError("not_found", "Deposit not found", 404);
    return;
  }
  if (type === "withdrawal") {
    const w = await WithdrawalModel.findById(id).select("_id").lean();
    if (!w) throw new AppError("not_found", "Withdrawal not found", 404);
    return;
  }
  if (type === "referral") {
    const accrual = await ReferralAccrualModel.findById(id).select("_id").lean();
    if (!accrual) throw new AppError("not_found", "Referral accrual not found", 404);
    return;
  }
  const person = await LiabilityPersonModel.findById(id).lean();
  if (!person) throw new AppError("not_found", "Liability person not found", 404);
  if (!person.isActive) throw new AppError("business_rule_error", "Liability person is inactive", 400);
}

export async function createLiabilityPerson(
  input: {
    name: string;
    phone?: string;
    email?: string;
    notes?: string;
    isActive?: boolean;
    openingBalance?: number;
    openingAmount?: number;
    openingKind?: "payable" | "receivable";
    openingOperatedCurrency?: string;
    openingOperatedAmount?: number;
    openingExchangeRate?: number;
  },
  actorId: string,
  requestId?: string,
) {
  const operatedOpeningAbs =
    input.openingAmount !== undefined
      ? Number(input.openingAmount)
      : input.openingBalance !== undefined
        ? Math.abs(Number(input.openingBalance))
        : 0;

  let signedOpening = 0;
  let openingFx: {
    openingOperatedCurrency?: string;
    openingOperatedAmount?: number;
    openingExchangeRate?: number;
  } = {};

  if (operatedOpeningAbs > 0 || input.openingOperatedCurrency || input.openingExchangeRate) {
    const opening = await resolveOpeningMoneyFromRequest({
      openingBalance: operatedOpeningAbs,
      openingOperatedCurrency: input.openingOperatedCurrency,
      openingOperatedAmount: input.openingOperatedAmount ?? operatedOpeningAbs,
      openingExchangeRate: input.openingExchangeRate,
    });
    const kind =
      input.openingKind ??
      (input.openingBalance !== undefined && Number(input.openingBalance) < 0 ? "payable" : "receivable");
    signedOpening = kind === "payable" ? -opening.openingBalance : opening.openingBalance;
    if (operatedOpeningAbs === 0 && input.openingAmount === undefined && input.openingBalance === undefined) {
      signedOpening = 0;
    }
    if (input.openingAmount !== undefined && input.openingAmount === 0) signedOpening = 0;
    openingFx = {
      openingOperatedCurrency: opening.openingOperatedCurrency,
      openingOperatedAmount: opening.openingOperatedAmount,
      openingExchangeRate: opening.openingExchangeRate,
    };
  } else {
    signedOpening = resolveSignedOpeningFromPersonBody(input, "create") ?? 0;
  }

  const doc = await LiabilityPersonModel.create({
    name: input.name.trim(),
    phone: input.phone?.trim() ?? "",
    email: input.email?.trim() ?? "",
    notes: input.notes?.trim() ?? "",
    isActive: input.isActive ?? true,
    openingBalance: signedOpening,
    ...openingFx,
    totalDebits: 0,
    totalCredits: 0,
    closingBalance: signedOpening,
    createdBy: new Types.ObjectId(actorId),
  });

  await createAuditLog({
    actorId,
    action: "liability.person.create",
    entity: "liability_person",
    entityId: doc._id.toString(),
    newValue: {
      name: doc.name,
      openingBalance: doc.openingBalance,
      openingOperatedCurrency: doc.openingOperatedCurrency,
      openingOperatedAmount: doc.openingOperatedAmount,
      openingExchangeRate: doc.openingExchangeRate,
      isActive: doc.isActive,
    },
    requestId,
  });

  return doc;
}

export async function updateLiabilityPerson(
  id: string,
  input: {
    name?: string;
    phone?: string;
    email?: string;
    notes?: string;
    isActive?: boolean;
    openingBalance?: number;
    openingAmount?: number;
    openingKind?: "payable" | "receivable";
  },
  actorId: string,
  requestId?: string,
) {
  const doc = await LiabilityPersonModel.findById(id);
  if (!doc) throw new AppError("not_found", "Liability person not found", 404);

  const prev = {
    name: doc.name,
    phone: doc.phone,
    email: doc.email,
    notes: doc.notes,
    isActive: doc.isActive,
    openingBalance: doc.openingBalance,
  };

  const signedOpening = resolveSignedOpeningFromPersonBody(input, "update");
  const openingUpdated = signedOpening !== undefined;

  if (input.name !== undefined) doc.name = input.name.trim();
  if (input.phone !== undefined) doc.phone = input.phone.trim();
  if (input.email !== undefined) doc.email = input.email.trim();
  if (input.notes !== undefined) doc.notes = input.notes.trim();
  if (input.isActive !== undefined) doc.isActive = input.isActive;
  if (openingUpdated) doc.openingBalance = signedOpening;
  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();
  if (openingUpdated) {
    await recomputePersonRollup(id);
    const refreshed = await LiabilityPersonModel.findById(id);
    if (refreshed) doc.set(refreshed.toObject());
  }

  await createAuditLog({
    actorId,
    action: "liability.person.update",
    entity: "liability_person",
    entityId: doc._id.toString(),
    oldValue: prev as unknown as Record<string, unknown>,
    newValue: {
      name: doc.name,
      phone: doc.phone,
      email: doc.email,
      notes: doc.notes,
      isActive: doc.isActive,
      openingBalance: doc.openingBalance,
    },
    requestId,
  });

  return doc;
}

export async function listLiabilityPersons(query: ListLiabilityPersonQuery, _options?: { timeZone?: string }) {
  const page = query.page;
  const pageSize = pageSizeFromQuery(query);
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const conditions: Record<string, unknown>[] = [];
  const search = trimUndef(query.search);
  if (search) {
    const esc = escapeRegex(search);
    conditions.push({
      $or: [
        { name: { $regex: esc, $options: "i" } },
        { phone: { $regex: esc, $options: "i" } },
        { email: { $regex: esc, $options: "i" } },
      ],
    });
  }
  if (query.isActive === "true") conditions.push({ isActive: true });
  if (query.isActive === "false") conditions.push({ isActive: false });

  const filter = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

  const [rawRows, total] = await Promise.all([
    LiabilityPersonModel.find(filter)
      .populate("createdBy", "fullName username")
      .populate("updatedBy", "fullName username")
      .sort({ [query.sortBy]: sortValue })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    LiabilityPersonModel.countDocuments(filter),
  ]);

  const rows = rawRows.map((r) => enrichPersonListRow(r));

  return {
    rows,
    meta: { total, page, pageSize },
  };
}

export async function createLiabilityEntry(
  input: {
    entryDate: string;
    entryType: "receipt" | "payment" | "contra" | "journal";
    amount: number;
    fromAccountType: LiabilityEntryAccountLiteral;
    fromAccountId: string;
    toAccountType: LiabilityEntryAccountLiteral;
    toAccountId: string;
    sourceType?: "expense" | "deposit" | "withdrawal" | "referral";
    sourceExpenseId?: string;
    sourceDepositId?: string;
    sourceWithdrawalId?: string;
    sourceReferralAccrualId?: string;
    referenceNo?: string;
    remark?: string;
    operatedCurrency?: string;
    operatedAmount?: number;
    exchangeRate?: number;
  },
  actorId: string,
  requestId?: string,
) {
  validateDistinctEndpoints(input);
  await Promise.all([
    ensureAccountExists(input.fromAccountType, input.fromAccountId),
    ensureAccountExists(input.toAccountType, input.toAccountId),
  ]);

  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: getCurrencyMinUnit(await requirePlatformCurrency()) },
  );

  const doc = await LiabilityEntryModel.create({
    entryDate: parseYmdToDate(input.entryDate),
    entryType: input.entryType,
    amount: money.amount,
    operatedCurrency: money.operatedCurrency,
    operatedAmount: money.operatedAmount,
    exchangeRate: money.exchangeRate,
    fromAccountType: input.fromAccountType,
    fromAccountId: new Types.ObjectId(input.fromAccountId),
    toAccountType: input.toAccountType,
    toAccountId: new Types.ObjectId(input.toAccountId),
    sourceType: input.sourceType,
    sourceExpenseId: input.sourceExpenseId ? new Types.ObjectId(input.sourceExpenseId) : undefined,
    sourceDepositId: input.sourceDepositId ? new Types.ObjectId(input.sourceDepositId) : undefined,
    sourceWithdrawalId: input.sourceWithdrawalId ? new Types.ObjectId(input.sourceWithdrawalId) : undefined,
    sourceReferralAccrualId: input.sourceReferralAccrualId
      ? new Types.ObjectId(input.sourceReferralAccrualId)
      : undefined,
    referenceNo: input.referenceNo?.trim() ?? "",
    remark: input.remark?.trim() ?? "",
    createdBy: new Types.ObjectId(actorId),
  });

  const recalcTargets = new Set<string>();
  if (input.fromAccountType === "person") recalcTargets.add(input.fromAccountId);
  if (input.toAccountType === "person") recalcTargets.add(input.toAccountId);
  await Promise.all([...recalcTargets].map((personId) => recomputePersonRollup(personId)));

  await createAuditLog({
    actorId,
    action: "liability.entry.create",
    entity: "liability_entry",
    entityId: doc._id.toString(),
    newValue: {
      entryDate: input.entryDate,
      entryType: input.entryType,
      amount: money.amount,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
      fromAccountType: input.fromAccountType,
      fromAccountId: input.fromAccountId,
      toAccountType: input.toAccountType,
      toAccountId: input.toAccountId,
      sourceType: input.sourceType,
      sourceExpenseId: input.sourceExpenseId,
      sourceDepositId: input.sourceDepositId,
      sourceWithdrawalId: input.sourceWithdrawalId,
      referenceNo: input.referenceNo?.trim() || undefined,
      remark: input.remark?.trim() || undefined,
    } as unknown as Record<string, unknown>,
    requestId,
  });

  return doc;
}

/** Remove a system-generated liability entry (e.g. deposit/withdrawal settlement) for reversal flows. */
export async function deleteLiabilityEntryForReversal(entryId: string, actorId: string, requestId?: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(entryId)) throw new AppError("validation_error", "Invalid liability entry id", 400);
  const eid = new Types.ObjectId(entryId);
  const doc = await LiabilityEntryModel.findById(eid).lean();
  if (!doc) return false;
  const recalcTargets = new Set<string>();
  if (doc.fromAccountType === "person") recalcTargets.add(String(doc.fromAccountId));
  if (doc.toAccountType === "person") recalcTargets.add(String(doc.toAccountId));
  await LiabilityEntryModel.deleteOne({ _id: eid });
  await Promise.all([...recalcTargets].map((personId) => recomputePersonRollup(personId)));
  await createAuditLog({
    actorId,
    action: "liability.entry.delete",
    entity: "liability_entry",
    entityId: entryId,
    oldValue: {
      entryDate: doc.entryDate,
      amount: doc.amount,
      fromAccountType: doc.fromAccountType,
      toAccountType: doc.toAccountType,
      sourceType: doc.sourceType,
    } as unknown as Record<string, unknown>,
    requestId,
  });
  return true;
}

export async function listLiabilityEntries(
  query: ListLiabilityEntryQuery,
  options?: { timeZone?: string },
) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const page = query.page;
  const pageSize = pageSizeFromQuery(query);
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const conditions: Record<string, unknown>[] = [];
  if (query.entryType) conditions.push({ entryType: query.entryType });

  const accountType = trimUndef(query.accountType);
  const accountId = trimUndef(query.accountId);
  if (accountType && accountId && Types.ObjectId.isValid(accountId)) {
    const aid = new Types.ObjectId(accountId);
    conditions.push({
      $or: [
        { fromAccountType: accountType, fromAccountId: aid },
        { toAccountType: accountType, toAccountId: aid },
      ],
    });
  }

  const search = trimUndef(query.search);
  if (search) {
    const esc = escapeRegex(search);
    conditions.push({
      $or: [
        { referenceNo: { $regex: esc, $options: "i" } },
        { remark: { $regex: esc, $options: "i" } },
      ],
    });
  }

  const from = trimUndef(query.entryDate_from);
  const to = trimUndef(query.entryDate_to);
  const fromD = from ? ymdToUtcStart(from, timeZone) : null;
  const toD = to ? ymdToUtcEnd(to, timeZone) : null;
  if (fromD || toD) {
    conditions.push({
      entryDate: {
        ...(fromD ? { $gte: fromD } : {}),
        ...(toD ? { $lte: toD } : {}),
      },
    });
  }

  const filter = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

  const [rows, total] = await Promise.all([
    LiabilityEntryModel.find(filter)
      .populate("createdBy", "fullName username")
      .sort({ [query.sortBy]: sortValue })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    LiabilityEntryModel.countDocuments(filter),
  ]);

  const accountIds = new Set<string>();
  rows.forEach((r) => {
    accountIds.add(String(r.fromAccountId));
    accountIds.add(String(r.toAccountId));
  });
  const objectIds = [...accountIds]
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const [banks, persons, expenses, deposits, withdrawals, referrals] = await Promise.all([
    BankModel.find({ _id: { $in: objectIds } }).select("_id holderName bankName accountNumber").lean(),
    LiabilityPersonModel.find({ _id: { $in: objectIds } }).select("_id name").lean(),
    ExpenseModel.find({ _id: { $in: objectIds } }).select("_id description").lean(),
    DepositModel.find({ _id: { $in: objectIds } }).select("_id utr").lean(),
    WithdrawalModel.find({ _id: { $in: objectIds } }).select("_id utr payableAmount").lean(),
    ReferralAccrualModel.find({ _id: { $in: objectIds } }).select("_id accruedAmount").lean(),
  ]);
  const bankMap = new Map(
    banks.map((b) => [
      String(b._id),
      `${b.holderName} — ${b.bankName}${b.accountNumber ? ` (${String(b.accountNumber).slice(-4)})` : ""}`.trim(),
    ]),
  );
  const personMap = new Map(persons.map((p) => [String(p._id), p.name]));
  const expenseMap = new Map(
    expenses.map((e) => [String(e._id), e.description?.trim() ? `Expense: ${e.description.trim()}` : `Expense ${String(e._id).slice(-6)}`]),
  );
  const depositMap = new Map(
    deposits.map((d) => [
      String(d._id),
      d.utr?.trim()
        ? `Deposit UTR ${d.utr.trim()}`
        : `Deposit ${String(d._id).slice(-8)}`,
    ]),
  );
  const withdrawalMap = new Map(withdrawals.map((w) => [String(w._id), `Withdrawal ${String(w._id).slice(-8)}`]));
  const referralMap = new Map(
    referrals.map((r) => [String(r._id), `IB referral settle ${String(r._id).slice(-6)}`]),
  );

  const resolveAcctName = (
    t: LiabilityEntryDocument["fromAccountType"],
    idStr: string,
  ): string => {
    if (t === "bank") return bankMap.get(idStr) ?? idStr;
    if (t === "person") return personMap.get(idStr) ?? idStr;
    if (t === "expense") return expenseMap.get(idStr) ?? idStr;
    if (t === "deposit") return depositMap.get(idStr) ?? idStr;
    if (t === "withdrawal") return withdrawalMap.get(idStr) ?? idStr;
    if (t === "referral") return referralMap.get(idStr) ?? `IB referral settle ${idStr.slice(-6)}`;
    return idStr;
  };

  const mapped = rows.map((r) => {
    const fromId = String(r.fromAccountId);
    const toId = String(r.toAccountId);
    return {
      ...r,
      fromAccountName: resolveAcctName(r.fromAccountType as LiabilityEntryDocument["fromAccountType"], fromId),
      toAccountName: resolveAcctName(r.toAccountType as LiabilityEntryDocument["toAccountType"], toId),
    };
  });

  return {
    rows: mapped,
    meta: { total, page, pageSize },
  };
}

export async function getLiabilityPersonLedger(
  personId: string,
  query: LedgerQuery,
  options?: { timeZone?: string },
) {
  const viewMode = normalizeViewMode(query.viewMode);
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  if (!Types.ObjectId.isValid(personId)) throw new AppError("validation_error", "Invalid person id", 400);
  const pid = new Types.ObjectId(personId);
  const person = await LiabilityPersonModel.findById(pid).lean();
  if (!person) throw new AppError("not_found", "Liability person not found", 404);

  const entries = await LiabilityEntryModel.find({
    $or: [
      { fromAccountType: "person", fromAccountId: pid },
      { toAccountType: "person", toAccountId: pid },
    ],
  })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();

  const from = query.fromDate ? ymdToUtcStart(query.fromDate, timeZone) : null;
  const to = query.toDate ? ymdToUtcEnd(query.toDate, timeZone) : null;

  let running = person.openingBalance ?? 0;
  let periodOpeningBalance: number | undefined;
  const rows: Array<{
    _id: string;
    at: string;
    entryType: string;
    from: string;
    to: string;
    debit: number;
    credit: number;
    runningBalance: number;
    runningBalanceAbs: number;
    runningBalanceSide: ReturnType<typeof resolveSideFromBalance>;
    operatedCurrency?: string;
    exchangeRate?: number;
    referenceNo?: string;
    remark?: string;
  }> = [];

  const accountIds = new Set<string>([personId]);
  entries.forEach((e) => {
    accountIds.add(String(e.fromAccountId));
    accountIds.add(String(e.toAccountId));
  });
  const objectIds = [...accountIds]
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const [banks, persons, expenses, depositsList, withdrawalsList, referralsList] = await Promise.all([
    BankModel.find({ _id: { $in: objectIds } }).select("_id holderName bankName accountNumber").lean(),
    LiabilityPersonModel.find({ _id: { $in: objectIds } }).select("_id name").lean(),
    ExpenseModel.find({ _id: { $in: objectIds } }).select("_id description").lean(),
    DepositModel.find({ _id: { $in: objectIds } }).select("_id utr").lean(),
    WithdrawalModel.find({ _id: { $in: objectIds } }).select("_id utr").lean(),
    ReferralAccrualModel.find({ _id: { $in: objectIds } }).select("_id accruedAmount").lean(),
  ]);
  const bankMap = new Map(
    banks.map((b) => [
      String(b._id),
      `${b.holderName} — ${b.bankName}${b.accountNumber ? ` (${String(b.accountNumber).slice(-4)})` : ""}`.trim(),
    ]),
  );
  const personMap = new Map(persons.map((p) => [String(p._id), p.name]));
  const expenseMap = new Map(
    expenses.map((e) => [String(e._id), e.description?.trim() ? `Expense: ${e.description.trim()}` : `Expense ${String(e._id).slice(-6)}`]),
  );
  const depositLblMap = new Map(
    depositsList.map((d) => [
      String(d._id),
      d.utr?.trim()
        ? `Deposit UTR ${d.utr.trim()}`
        : `Deposit ${String(d._id).slice(-8)}`,
    ]),
  );
  const withdrawalLblMap = new Map(
    withdrawalsList.map((w) => [
      String(w._id),
      w.utr?.trim()
        ? `Withdrawal UTR ${w.utr.trim()}`
        : `Withdrawal ${String(w._id).slice(-8)}`,
    ]),
  );
  const referralLblMap = new Map(
    referralsList.map((r) => [String(r._id), `IB referral settle ${String(r._id).slice(-6)}`]),
  );

  const labelForLedger = (
    t: LiabilityEntryDocument["fromAccountType"],
    idStr: string,
  ): string => {
    if (t === "bank") return bankMap.get(idStr) ?? idStr;
    if (t === "person") return personMap.get(idStr) ?? idStr;
    if (t === "expense") return expenseMap.get(idStr) ?? idStr;
    if (t === "deposit") return depositLblMap.get(idStr) ?? idStr;
    if (t === "withdrawal") return withdrawalLblMap.get(idStr) ?? idStr;
    if (t === "referral") return referralLblMap.get(idStr) ?? `IB referral settle ${idStr.slice(-6)}`;
    return idStr;
  };

  for (const e of entries) {
    const at = new Date(e.entryDate ?? e.createdAt ?? new Date(0));
    const isInRange = (!from || at >= from) && (!to || at <= to);
    const fromId = String(e.fromAccountId);
    const toId = String(e.toAccountId);
    const isPersonFrom = e.fromAccountType === "person" && fromId === personId;
    const isPersonTo = e.toAccountType === "person" && toId === personId;
    const debit = isPersonTo ? e.amount : 0;
    const credit = isPersonFrom ? e.amount : 0;
    const delta = viewMode === "person" ? credit - debit : debit - credit;

    if (isInRange) {
      if (periodOpeningBalance === undefined) {
        periodOpeningBalance = running;
      }
      running += delta;
      rows.push({
        _id: String(e._id),
        at: formatDateTimeForTimeZone(at, timeZone),
        entryType: e.entryType,
        from: labelForLedger(e.fromAccountType as LiabilityEntryDocument["fromAccountType"], fromId),
        to: labelForLedger(e.toAccountType as LiabilityEntryDocument["fromAccountType"], toId),
        debit,
        credit,
        runningBalance: running,
        runningBalanceAbs: Math.abs(running),
        runningBalanceSide: resolveSideFromBalance(running),
        operatedCurrency: e.operatedCurrency ?? undefined,
        exchangeRate: e.exchangeRate ?? undefined,
        referenceNo: e.referenceNo?.trim() || undefined,
        remark: e.remark?.trim() || undefined,
      });
    } else {
      running += delta;
    }
  }

  const openingBal = person.openingBalance ?? 0;
  return {
    viewMode,
    person: {
      _id: String(person._id),
      name: person.name,
      openingBalance: openingBal,
      openingBalanceAbs: Math.abs(openingBal),
      openingSide: resolveSideFromBalance(openingBal),
    },
    rows,
    closingBalance: running,
    closingSide: resolveSideFromBalance(running),
    ...(periodOpeningBalance !== undefined
      ? {
          periodOpeningBalance,
          periodOpeningBalanceAbs: Math.abs(periodOpeningBalance),
          periodOpeningSide: resolveSideFromBalance(periodOpeningBalance),
        }
      : {}),
  };
}

function formatUserForExport(user: unknown): string {
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

export async function exportLiabilityPersonsToBuffer(
  query: ExportLiabilityPersonQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const result = await listLiabilityPersons({ ...query, page: 1, pageSize: EXPORT_MAX_ROWS }, options);
  const exportData = result.rows.map((r) => ({
    Name: r.name,
    Phone: r.phone ?? "",
    Email: r.email ?? "",
    Status: r.isActive ? "Active" : "Inactive",
    "Opening Amount": r.openingBalanceAbs,
    "Opening Side": r.openingBalanceSide,
    "Opening Balance (signed)": r.openingBalance ?? 0,
    "Total Credits": r.totalCredits ?? 0,
    "Total Debits": r.totalDebits ?? 0,
    "Closing Amount": r.closingBalanceAbs,
    "Closing Side": r.closingBalanceSide,
    "Closing Balance (signed)": r.closingBalance ?? 0,
    Notes: r.notes ?? "",
    "Created By": formatUserForExport(r.createdBy),
    "Updated By": formatUserForExport(r.updatedBy),
    "Created At": formatDateTimeForTimeZone(r.createdAt, timeZone),
  }));

  return generateExcelBuffer(exportData, "Liability Persons");
}

export async function exportLiabilityEntriesToBuffer(
  query: ExportLiabilityEntryQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const result = await listLiabilityEntries({ ...query, page: 1, pageSize: EXPORT_MAX_ROWS }, options);
  const exportData = result.rows.map((r) => ({
    Date: formatDateForTimeZone(r.entryDate, timeZone),
    Type: r.entryType,
    Amount: r.amount,
    "From Account": r.fromAccountName,
    "To Account": r.toAccountName,
    "Reference No": r.referenceNo ?? "",
    Remark: r.remark ?? "",
    "Source Type": r.sourceType ?? "",
    "Created By": formatUserForExport(r.createdBy),
    "Created At": formatDateTimeForTimeZone(r.createdAt, timeZone),
  }));

  return generateExcelBuffer(exportData, "Liability Entries");
}

export async function exportLiabilityLedgerToBuffer(
  personId: string,
  query: LedgerQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const result = await getLiabilityPersonLedger(personId, query, options);
  const exportData = result.rows.map((r) => ({
    Date: formatDateForTimeZone(r.at, timeZone),
    "Entry Type": r.entryType,
    From: r.from,
    To: r.to,
    Debit: r.debit,
    Credit: r.credit,
    "Running Amount": r.runningBalanceAbs,
    "Running Side": r.runningBalanceSide,
    "Running Balance (signed)": r.runningBalance,
    "Reference No": r.referenceNo ?? "",
    Remark: r.remark ?? "",
  }));
  const perspective = result.viewMode === "person" ? "Person-side" : "Platform-side";
  exportData.unshift({
    Date: "",
    "Entry Type": `${perspective} perspective`,
    From: "",
    To: "",
    Debit: "",
    Credit: "",
    "Running Amount": "",
    "Running Side": "",
    "Running Balance (signed)": "",
    "Reference No": "",
    Remark: "",
  } as unknown as (typeof exportData)[number]);
  return generateExcelBuffer(exportData, `Ledger - ${result.person.name}`);
}
export async function getLiabilityReportSummary(query?: { viewMode?: string }) {
  const viewMode = normalizeViewMode(query?.viewMode);
  const persons = await LiabilityPersonModel.find({ isActive: true }).lean();
  let totalReceivable = 0;
  let totalPayable = 0;
  persons.forEach((p) => {
    const bal = resolveBalanceByViewMode(
      {
        openingBalance: p.openingBalance,
        totalDebits: p.totalDebits,
        totalCredits: p.totalCredits,
      },
      viewMode,
    );
    const side = resolveSideFromBalance(bal);
    if (side === "receivable") totalReceivable += Math.abs(bal);
    if (side === "payable") totalPayable += Math.abs(bal);
  });

  const netPosition = totalReceivable - totalPayable;
  return {
    viewMode,
    totalReceivable,
    totalPayable,
    netPosition,
    netPositionAbs: Math.abs(netPosition),
    netPositionSide: resolveSideFromBalance(netPosition),
    totalPersons: persons.length,
  };
}

export async function getLiabilityReportPersonWise(query?: { viewMode?: string }) {
  const viewMode = normalizeViewMode(query?.viewMode);
  const persons = await LiabilityPersonModel.find({}).lean();

  return persons.map((p) => {
    const balance = resolveBalanceByViewMode(
      {
        openingBalance: p.openingBalance,
        totalDebits: p.totalDebits,
        totalCredits: p.totalCredits,
      },
      viewMode,
    );
    const resolvedSide = resolveSideFromBalance(balance);
    return {
      personId: String(p._id),
      name: p.name,
      isActive: p.isActive,
      balance,
      balanceAbs: Math.abs(balance),
      totalCredits: Number(p.totalCredits ?? 0),
      totalDebits: Number(p.totalDebits ?? 0),
      side: resolvedSide === "settled" ? "receivable" : resolvedSide,
      sideLabel: resolvedSide === "settled" ? "settled" : resolvedSide,
      viewMode,
    };
  });
}
