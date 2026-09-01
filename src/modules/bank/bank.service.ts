import { randomUUID } from "crypto";
import { Types } from "mongoose";
import type { z } from "zod";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { DepositModel } from "../deposit/deposit.model";
import { WithdrawalModel } from "../withdrawal/withdrawal.model";
import { ExpenseModel } from "../expense/expense.model";
import { LiabilityEntryModel } from "../liability/liability-entry.model";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { ReferralAccrualModel } from "../referral/referral-accrual.model";
import {
  DEFAULT_TIMEZONE,
  formatDateTimeForTimeZone,
  ymdToUtcEnd,
  ymdToUtcStart,
} from "../../shared/utils/timezone";
import { BankModel, type BankDocument } from "./bank.model";
import { BankBalanceSettlementModel } from "./bank-balance-settlement.model";
import { computeClosingBalanceActualByBankIds } from "./bankClosingBalance";
import { listBankQuerySchema } from "./bank.validation";
import { resolveOpeningMoneyFromRequest } from "../../shared/utils/moneyFx";
import { invalidateCacheDomains } from "../../shared/cache/domainCache";
import { bankDisplayName, bankMethodLabel, toMethodCode } from "./bank.constants";
import { PaymentMethodModel } from "../masters/payment-method.model";

type ListBankQuery = z.infer<typeof listBankQuerySchema>;

function pageSizeFromQuery(q: ListBankQuery): number {
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

function textFieldCondition(field: string, value: string, op: string | undefined): Record<string, unknown> {
  const operator = op || "contains";
  const esc = escapeRegex(value);
  switch (operator) {
    case "contains":
      return { [field]: { $regex: esc, $options: "i" } };
    case "notContains":
      return { [field]: { $not: new RegExp(esc, "i") } };
    case "equals":
      return { [field]: { $regex: `^${esc}$`, $options: "i" } };
    case "notEquals":
      return { [field]: { $not: new RegExp(`^${esc}$`, "i") } };
    case "startsWith":
      return { [field]: { $regex: `^${esc}`, $options: "i" } };
    case "endsWith":
      return { [field]: { $regex: `${esc}$`, $options: "i" } };
    default:
      return { [field]: { $regex: esc, $options: "i" } };
  }
}

function numberFieldCondition(
  field: string,
  value: string | undefined,
  op: string | undefined,
  valueTo: string | undefined,
): Record<string, unknown> | null {
  const v = trimUndef(value);
  if (v == null) return null;
  const num = Number(v);
  if (!Number.isFinite(num)) return null;
  const operator = op || "equals";
  const numToRaw = trimUndef(valueTo);
  const toNum = numToRaw != null ? Number(numToRaw) : NaN;

  switch (operator) {
    case "equals":
      return { [field]: num };
    case "notEquals":
      return { [field]: { $ne: num } };
    case "gt":
      return { [field]: { $gt: num } };
    case "gte":
      return { [field]: { $gte: num } };
    case "lt":
      return { [field]: { $lt: num } };
    case "lte":
      return { [field]: { $lte: num } };
    case "between":
      if (numToRaw != null && Number.isFinite(toNum)) {
        return { [field]: { $gte: Math.min(num, toNum), $lte: Math.max(num, toNum) } };
      }
      return { [field]: num };
    default:
      return { [field]: num };
  }
}

function createdAtCondition(
  from: string | undefined,
  to: string | undefined,
  op: string | undefined,
  timeZone: string,
): Record<string, unknown> | null {
  const operator = op || "inRange";
  const f = trimUndef(from);
  const t = trimUndef(to);

  if (operator === "inRange" && f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (operator === "equals" && f) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(f, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (operator === "before" && f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { createdAt: { $lt: start } };
  }
  if (operator === "after" && f) {
    const end = ymdToUtcEnd(f, timeZone);
    if (!end) return null;
    return { createdAt: { $gt: end } };
  }
  if (f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { createdAt: { $gte: start, $lte: end } };
  }
  if (f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { createdAt: { $gte: start } };
  }
  if (t) {
    const end = ymdToUtcEnd(t, timeZone);
    if (!end) return null;
    return { createdAt: { $lte: end } };
  }
  return null;
}

function buildBankListFilter(q: ListBankQuery, timeZone: string): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];

  const search = trimUndef(q.search);
  if (search) {
    const esc = escapeRegex(search);
    conditions.push({
      $or: [
        { holderName: { $regex: esc, $options: "i" } },
        { bankName: { $regex: esc, $options: "i" } },
        { accountNumber: { $regex: esc, $options: "i" } },
        { ifsc: { $regex: esc, $options: "i" } },
        { method: { $regex: esc, $options: "i" } },
      ],
    });
  }

  const method = trimUndef(q.method);
  if (method) {
    conditions.push({ method });
  }

  const holderName = trimUndef(q.holderName);
  if (holderName) {
    conditions.push(textFieldCondition("holderName", holderName, trimUndef(q.holderName_op)));
  }

  const bankName = trimUndef(q.bankName);
  if (bankName) {
    conditions.push(textFieldCondition("bankName", bankName, trimUndef(q.bankName_op)));
  }

  const accountNumber = trimUndef(q.accountNumber);
  if (accountNumber) {
    conditions.push(textFieldCondition("accountNumber", accountNumber, trimUndef(q.accountNumber_op)));
  }

  const ifsc = trimUndef(q.ifsc);
  if (ifsc) {
    conditions.push(textFieldCondition("ifsc", ifsc, trimUndef(q.ifsc_op)));
  }

  const status = trimUndef(q.status);
  if (status === "active" || status === "deactive") {
    conditions.push({ status });
  }

  const createdBy = trimUndef(q.createdBy);
  if (createdBy && Types.ObjectId.isValid(createdBy)) {
    conditions.push({ createdBy: new Types.ObjectId(createdBy) });
  }

  const dateCond = createdAtCondition(
    trimUndef(q.createdAt_from),
    trimUndef(q.createdAt_to),
    trimUndef(q.createdAt_op),
    timeZone,
  );
  if (dateCond) {
    conditions.push(dateCond);
  }

  const ob = numberFieldCondition(
    "openingBalance",
    trimUndef(q.openingBalance),
    trimUndef(q.openingBalance_op),
    trimUndef(q.openingBalance_to),
  );
  if (ob) {
    conditions.push(ob);
  }

  if (conditions.length === 0) {
    return {};
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return { $and: conditions };
}

const EXPORT_MAX_ROWS = 10_000;

function formatCreatedByForExport(createdBy: unknown): string {
  if (createdBy == null) return "";
  if (typeof createdBy === "object" && createdBy !== null && "_id" in createdBy) {
    const u = createdBy as { fullName?: string; username?: string; _id?: Types.ObjectId };
    const fn = u.fullName?.trim();
    const un = u.username?.trim();
    if (fn && un) return `${fn} (${un})`;
    if (fn) return fn;
    if (un) return un;
    return u._id?.toString() ?? "";
  }
  return String(createdBy);
}

function generateAccountNumber(method: string): string {
  const prefix = method.replace(/_/g, "").toUpperCase().slice(0, 10) || "PAY";
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
}

async function resolvePaymentMethod(inputMethod?: string): Promise<{ code: string; label: string }> {
  const raw = String(inputMethod ?? "").trim();
  if (!raw) {
    throw new AppError("validation_error", "Payment method is required", 400);
  }

  const codeCandidate = toMethodCode(raw);
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const or: Record<string, unknown>[] = [
    { code: codeCandidate },
    { code: { $regex: `^${esc}$`, $options: "i" } },
    { name: { $regex: `^${esc}$`, $options: "i" } },
  ];
  if (Types.ObjectId.isValid(raw)) {
    or.push({ _id: new Types.ObjectId(raw) });
  }

  const row = await PaymentMethodModel.findOne({
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    $and: [{ $or: or }],
  })
    .select({ name: 1, code: 1 })
    .lean()
    .exec();

  if (!row) {
    throw new AppError(
      "validation_error",
      "Unknown or inactive payment method. Add it under Masters → Payment Method first.",
      400,
    );
  }

  const code = String(row.code ?? "").trim() || toMethodCode(String(row.name ?? raw));
  const label = String(row.name ?? "").trim() || bankMethodLabel(code) || code;
  return { code, label };
}

export async function createBank(input: {
  method?: string;
  name?: string;
  holderName?: string;
  bankName?: string;
  accountNumber?: string;
  ifsc?: string;
  openingBalance: number;
  status: "active" | "deactive";
  openingOperatedCurrency?: string;
  openingOperatedAmount?: number;
  openingExchangeRate?: number;
}, actorId: string, requestId?: string): Promise<{ doc: BankDocument; created: boolean }> {
  const resolved = await resolvePaymentMethod(input.method);
  const method = resolved.code;
  const defaultLabel = resolved.label;
  const holderName = (input.name || input.holderName || defaultLabel).trim();
  const bankName = (input.bankName || defaultLabel).trim();

  const opening = await resolveOpeningMoneyFromRequest({
    openingBalance: input.openingBalance,
    openingOperatedCurrency: input.openingOperatedCurrency,
    openingOperatedAmount: input.openingOperatedAmount,
    openingExchangeRate: input.openingExchangeRate,
  });

  const existingByMethod = await BankModel.findOne({ method }).sort({ createdAt: 1 });
  if (existingByMethod) {
    const oldValue = {
      method: existingByMethod.method,
      holderName: existingByMethod.holderName,
      bankName: existingByMethod.bankName,
      openingBalance: existingByMethod.openingBalance,
      openingOperatedCurrency: existingByMethod.openingOperatedCurrency,
      openingOperatedAmount: existingByMethod.openingOperatedAmount,
      openingExchangeRate: existingByMethod.openingExchangeRate,
      status: existingByMethod.status,
    };

    existingByMethod.holderName = holderName;
    existingByMethod.bankName = bankName;
    existingByMethod.openingBalance = opening.openingBalance;
    existingByMethod.openingOperatedCurrency = opening.openingOperatedCurrency;
    existingByMethod.openingOperatedAmount = opening.openingOperatedAmount;
    existingByMethod.openingExchangeRate = opening.openingExchangeRate;
    existingByMethod.status = input.status;
    await existingByMethod.save();

    await createAuditLog({
      actorId,
      action: "bank.update",
      entity: "bank",
      entityId: existingByMethod._id.toString(),
      oldValue: oldValue as unknown as Record<string, unknown>,
      newValue: {
        method: existingByMethod.method,
        holderName: existingByMethod.holderName,
        bankName: existingByMethod.bankName,
        openingBalance: existingByMethod.openingBalance,
        openingOperatedCurrency: existingByMethod.openingOperatedCurrency,
        openingOperatedAmount: existingByMethod.openingOperatedAmount,
        openingExchangeRate: existingByMethod.openingExchangeRate,
        status: existingByMethod.status,
      } as unknown as Record<string, unknown>,
      requestId,
    });
    await invalidateCacheDomains(["bank"]);
    return { doc: existingByMethod, created: false };
  }

  const accountNumber = (input.accountNumber || generateAccountNumber(method)).trim();
  const ifsc = (input.ifsc || "N/A").trim();

  const existing = await BankModel.findOne({ accountNumber });
  if (existing) throw new AppError("business_rule_error", "Account number already exists", 409);

  const doc = await BankModel.create({
    method,
    holderName,
    bankName,
    accountNumber,
    ifsc,
    status: input.status,
    openingBalance: opening.openingBalance,
    openingOperatedCurrency: opening.openingOperatedCurrency,
    openingOperatedAmount: opening.openingOperatedAmount,
    openingExchangeRate: opening.openingExchangeRate,
    currentBalance: opening.openingBalance,
    createdBy: new Types.ObjectId(actorId),
  });
  await createAuditLog({
    actorId,
    action: "bank.create",
    entity: "bank",
    entityId: doc._id.toString(),
    newValue: {
      method,
      holderName,
      bankName,
      accountNumber,
      ifsc,
      openingBalance: opening.openingBalance,
      openingOperatedCurrency: opening.openingOperatedCurrency,
      openingOperatedAmount: opening.openingOperatedAmount,
      openingExchangeRate: opening.openingExchangeRate,
      status: input.status,
    } as unknown as Record<string, unknown>,
    requestId,
  });
  await invalidateCacheDomains(["bank"]);
  return { doc, created: true };
}

export async function listBanks(query: ListBankQuery, options?: { timeZone?: string }) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildBankListFilter(query, timeZone);
  const page = query.page;
  const pageSize = pageSizeFromQuery(query);
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    BankModel.find(filter)
      .populate("createdBy", "fullName username")
      .sort({ [query.sortBy]: sortValue })
      .skip(skip)
      .limit(pageSize)
      .lean(),
    BankModel.countDocuments(filter),
  ]);

  const bankIds = rows.map((r) => new Types.ObjectId(String(r._id)));
  const closingByBankId = await computeClosingBalanceActualByBankIds(bankIds);
  const rowsWithClosing = rows.map((r) => ({
    ...r,
    closingBalanceActual: closingByBankId.get(String(r._id)) ?? Number(r.openingBalance ?? 0),
  }));

  return {
    rows: rowsWithClosing,
    meta: {
      page,
      pageSize,
      total,
    },
  };
}

export async function exportBanksToBuffer(
  query: ListBankQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildBankListFilter(query, timeZone);
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const rows = await BankModel.find(filter)
    .populate("createdBy", "fullName username")
    .sort({ [query.sortBy]: sortValue })
    .limit(EXPORT_MAX_ROWS)
    .lean();

  return generateExcelBuffer(rows, [
    { header: "Name", key: "holderName" },
    { header: "Method", key: "method" },
    { header: "Opening Balance", key: "openingBalance" },
    { header: "Status", key: "status" },
    { header: "Created By", transform: (r) => formatCreatedByForExport(r.createdBy) },
    { header: "Created At", transform: (r) => formatDateTimeForTimeZone(r.createdAt, timeZone) },
  ], "Banks");
}

type LedgerQuery = {
  fromDate?: string;
  toDate?: string;
  entryType?: "all" | "deposit" | "withdrawal" | "expense" | "liability" | "settlement" | "referral";
};

function settlementEventTime(s: { effectiveAt: Date }): Date {
  return new Date(s.effectiveAt);
}

function depositEventTime(d: { settledAt?: Date; createdAt?: Date }): Date {
  if (d.settledAt) return new Date(d.settledAt);
  if (d.createdAt) return new Date(d.createdAt);
  return new Date(0);
}

function withdrawalEventTime(w: { updatedAt?: Date; createdAt?: Date }): Date {
  if (w.updatedAt) return new Date(w.updatedAt);
  if (w.createdAt) return new Date(w.createdAt);
  return new Date(0);
}

function expenseEventTime(e: { approvedAt?: Date; createdAt?: Date }): Date {
  if (e.approvedAt) return new Date(e.approvedAt);
  if (e.createdAt) return new Date(e.createdAt);
  return new Date(0);
}

function referralSettleEventTime(r: { settledAt?: Date; updatedAt?: Date; createdAt?: Date }): Date {
  if (r.settledAt) return new Date(r.settledAt);
  if (r.updatedAt) return new Date(r.updatedAt);
  if (r.createdAt) return new Date(r.createdAt);
  return new Date(0);
}

function liabilityEventTime(e: { entryDate?: Date; createdAt?: Date }): Date {
  if (e.entryDate) return new Date(e.entryDate);
  if (e.createdAt) return new Date(e.createdAt);
  return new Date(0);
}

/**
 * Merged deposit credits, withdrawal debits, and approved expense debits for a bank account (chronological ledger).
 * Withdrawal rows are sourced from banker-paid entries (status: approved) for the selected payout bank.
 * Reverse bonus is memo-only and never posted as a separate cash ledger row.
 */
export async function getBankLedger(bankId: string, query: LedgerQuery, options?: { timeZone?: string }) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  if (!Types.ObjectId.isValid(bankId)) {
    throw new AppError("validation_error", "Invalid bank id", 400);
  }
  const bid = new Types.ObjectId(bankId);
  const bank = await BankModel.findById(bid).lean();
  if (!bank) throw new AppError("not_found", "Bank not found", 404);

  const from = query.fromDate?.trim();
  const to = query.toDate?.trim();
  const fromD = from ? ymdToUtcStart(from, timeZone) : null;
  const toD = to ? ymdToUtcEnd(to, timeZone) : null;
  const entryType = query.entryType || "all";

  const [allDeposits, allWithdrawals, allExpenses, allReferralSettles, allLiabilityEntries, allSettlements] =
    await Promise.all([
      DepositModel.find({ bankId: bid, status: "verified" })
        .populate("player", "name")
        .populate("createdBy", "fullName")
        .lean(),
      WithdrawalModel.find({ payoutBankId: bid, status: "approved" })
        .populate("player", "name")
        .populate("createdBy", "fullName")
        .lean(),
      ExpenseModel.find({ bankId: bid, status: "approved" }).lean(),
      ReferralAccrualModel.find({
        bankId: bid,
        status: "settled",
        settlementAccountType: "bank",
      }).lean(),
      LiabilityEntryModel.find({
        $or: [
          { fromAccountType: "bank", fromAccountId: bid },
          { toAccountType: "bank", toAccountId: bid },
        ],
      })
        .populate("createdBy", "fullName")
        .lean(),
      BankBalanceSettlementModel.find({ bankId: bid })
        .populate("createdBy", "fullName username")
        .lean(),
    ]);

  const liabilityPersonIds = new Set<string>();
  for (const e of allLiabilityEntries) {
    if (e.fromAccountType === "person") liabilityPersonIds.add(String(e.fromAccountId));
    if (e.toAccountType === "person") liabilityPersonIds.add(String(e.toAccountId));
  }
  const liabilityPersons = await LiabilityPersonModel.find({
    _id: { $in: [...liabilityPersonIds].filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) },
  })
    .select("_id name")
    .lean();
  const liabilityPersonMap = new Map(liabilityPersons.map((p) => [String(p._id), p.name]));

  let priorNet = 0;
  if (fromD) {
    for (const d of allDeposits) {
      const at = depositEventTime(d);
      if (at >= fromD) continue;
      // Bonus is OFF balance sheet
      priorNet += d.amount;
    }
    for (const w of allWithdrawals) {
      const at = withdrawalEventTime(w);
      if (at >= fromD) continue;
      // Reverse bonus stays memo-only; cash movement is payable amount only.
      priorNet -= w.payableAmount ?? w.amount;
    }
    for (const e of allExpenses) {
      const at = expenseEventTime(e);
      if (at >= fromD) continue;
      priorNet -= e.amount;
    }
    for (const r of allReferralSettles) {
      const at = referralSettleEventTime(r);
      if (at >= fromD) continue;
      priorNet -= Number(r.accruedAmount ?? 0);
    }
    for (const le of allLiabilityEntries) {
      const at = liabilityEventTime(le);
      if (at >= fromD) continue;
      const isBankFrom = le.fromAccountType === "bank" && String(le.fromAccountId) === String(bid);
      const isBankTo = le.toAccountType === "bank" && String(le.toAccountId) === String(bid);
      if (isBankFrom) priorNet -= le.amount;
      if (isBankTo) priorNet += le.amount;
    }
    for (const st of allSettlements) {
      const at = settlementEventTime(st);
      if (at >= fromD) continue;
      priorNet += Number(st.signedAmount ?? 0);
    }
  }

  type SettlementLean = (typeof allSettlements)[number];

  type Ev =
    | { kind: "deposit"; t: number; doc: (typeof allDeposits)[0] }
    | { kind: "withdrawal"; t: number; doc: (typeof allWithdrawals)[0] }
    | { kind: "expense"; t: number; doc: (typeof allExpenses)[0] }
    | { kind: "referral"; t: number; doc: (typeof allReferralSettles)[0] }
    | { kind: "liability"; t: number; doc: (typeof allLiabilityEntries)[0] }
    | { kind: "settlement"; t: number; doc: SettlementLean };

  const events: Ev[] = [];
  for (const d of allDeposits) {
    const at = depositEventTime(d);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "deposit") {
      events.push({ kind: "deposit", t: at.getTime(), doc: d });
    }
  }
  for (const w of allWithdrawals) {
    const at = withdrawalEventTime(w);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "withdrawal") {
      events.push({ kind: "withdrawal", t: at.getTime(), doc: w });
    }
  }
  for (const e of allExpenses) {
    const at = expenseEventTime(e);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "expense") {
      events.push({ kind: "expense", t: at.getTime(), doc: e });
    }
  }
  for (const r of allReferralSettles) {
    const at = referralSettleEventTime(r);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "referral") {
      events.push({ kind: "referral", t: at.getTime(), doc: r });
    }
  }
  for (const le of allLiabilityEntries) {
    const at = liabilityEventTime(le);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "liability") {
      events.push({ kind: "liability", t: at.getTime(), doc: le });
    }
  }
  for (const st of allSettlements) {
    const at = settlementEventTime(st);
    if (fromD && at < fromD) continue;
    if (toD && at > toD) continue;
    if (entryType === "all" || entryType === "settlement") {
      events.push({ kind: "settlement", t: at.getTime(), doc: st });
    }
  }
  events.sort((a, b) => a.t - b.t);

  const periodOpeningBalance = bank.openingBalance + priorNet;
  let running = periodOpeningBalance;
  let totalCredits = 0;
  let totalDebits = 0;
  let totalBonusGiven = 0;
  let totalBonusReversed = 0;

  const rows = events.map((ev) => {
    if (ev.kind === "deposit") {
      const d = ev.doc;
      const amt = d.amount; // Base amount only (cash in bank)
      const bonus = d.bonusAmount ?? 0;
      running += amt;
      totalCredits += amt;
      totalBonusGiven += bonus;
      
      const playerObj = d.player as { name?: string } | undefined;
      const createdByObj = d.createdBy as { fullName?: string } | undefined;

      return {
        kind: "deposit" as const,
        refId: d._id.toString(),
        at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
        label: `Deposit`,
        utr: d.utr,
        playerName: playerObj?.name ?? "",
        createdByName: createdByObj?.fullName ?? "",
        amount: amt,
        direction: "credit" as const,
        balanceAfter: running,
        bonusMemo: bonus > 0 ? bonus : undefined,
      };
    }
    
    if (ev.kind === "withdrawal") {
      const w = ev.doc;
      const amt = w.payableAmount ?? w.amount; // Actual cash paid from company bank
      const reversal = w.reverseBonus ?? 0;
      running -= amt;
      totalDebits += amt;
      totalBonusReversed += reversal;

      const playerObj = w.player as { name?: string } | undefined;
      const createdByObj = w.createdBy as { fullName?: string } | undefined;

      return {
        kind: "withdrawal" as const,
        refId: w._id.toString(),
        at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
        label: `Withdrawal`,
        utr: w.utr,
        playerName: playerObj?.name ?? w.playerName ?? "",
        createdByName: createdByObj?.fullName ?? "",
        amount: amt,
        direction: "debit" as const,
        balanceAfter: running,
        bonusMemo: reversal > 0 ? reversal : undefined,
      };
    }
    
    if (ev.kind === "liability") {
      const le = ev.doc;
      const isBankFrom = le.fromAccountType === "bank" && String(le.fromAccountId) === String(bid);
      const direction = isBankFrom ? "debit" : "credit";
      if (direction === "debit") {
        running -= le.amount;
        totalDebits += le.amount;
      } else {
        running += le.amount;
        totalCredits += le.amount;
      }
      const createdByObj = le.createdBy as { fullName?: string } | undefined;
      const counterpartyName =
        le.fromAccountType === "person"
          ? liabilityPersonMap.get(String(le.fromAccountId)) ?? ""
          : le.toAccountType === "person"
            ? liabilityPersonMap.get(String(le.toAccountId)) ?? ""
            : "";
      return {
        kind: "liability" as const,
        refId: le._id.toString(),
        at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
        label: `Liability ${le.entryType}`,
        utr: le.referenceNo?.trim() || undefined,
        playerName: counterpartyName,
        createdByName: createdByObj?.fullName ?? "",
        amount: le.amount,
        direction,
        balanceAfter: running,
        bonusMemo: undefined,
      };
    }

    if (ev.kind === "settlement") {
      const st = ev.doc;
      const signed = Number(st.signedAmount ?? 0);
      const amt = Math.abs(signed);
      if (signed >= 0) {
        running += amt;
        totalCredits += amt;
      } else {
        running -= amt;
        totalDebits += amt;
      }
      const createdByObj = st.createdBy as { fullName?: string; username?: string } | undefined;
      const createdLabel = createdByObj?.fullName?.trim()
        ? createdByObj.fullName.trim()
        : createdByObj?.username?.trim() ?? "";
      return {
        kind: "settlement" as const,
        refId: st._id.toString(),
        at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
        label: "Master balance settlement",
        utr: undefined,
        playerName: st.reason?.trim() ? st.reason.trim().slice(0, 200) : "",
        createdByName: createdLabel,
        amount: amt,
        direction: signed >= 0 ? ("credit" as const) : ("debit" as const),
        balanceAfter: running,
        bonusMemo: undefined,
      };
    }

    if (ev.kind === "referral") {
      const r = ev.doc;
      const amt = Number(r.accruedAmount ?? 0);
      const ref = `REF-IB-${String(r._id).slice(-8).toUpperCase()}`;
      running -= amt;
      totalDebits += amt;
      return {
        kind: "referral" as const,
        refId: String(r._id),
        at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
        label: r.settlementRemark?.trim()
          ? `IB referral settle: ${r.settlementRemark.trim()}`
          : "IB referral settle",
        utr: ref,
        playerName: "",
        createdByName: "",
        amount: amt,
        direction: "debit" as const,
        balanceAfter: running,
        bonusMemo: undefined,
      };
    }

    // expense
    const e = ev.doc;
    running -= e.amount;
    totalDebits += e.amount;
    return {
      kind: "expense" as const,
      refId: e._id.toString(),
      at: formatDateTimeForTimeZone(new Date(ev.t), timeZone),
      label: e.description?.trim() ? e.description.trim() : "Expense",
      utr: undefined,
      playerName: "",
      createdByName: "",
      amount: e.amount,
      direction: "debit" as const,
      balanceAfter: running,
      bonusMemo: undefined,
    };
  });

  return {
    bank: {
      _id: bank._id.toString(),
      method: bank.method,
      holderName: bank.holderName,
      bankName: bank.bankName,
      accountNumber: bank.accountNumber,
      displayName: bankDisplayName(bank),
      openingBalance: bank.openingBalance,
      currentBalance: bank.currentBalance ?? bank.openingBalance,
    },
    periodOpeningBalance,
    periodClosingBalance: running,
    totalCredits,
    totalDebits,
    totalBonusGiven,
    totalBonusReversed,
    rows,
  };
}

export type CreateBankSettlementInput = {
  effectiveAt: Date;
  masterReportedBalance: number;
  reason: string;
};

export async function getBankComputedClosingBalance(bankId: string): Promise<{ systemClosingBalance: number }> {
  if (!Types.ObjectId.isValid(bankId)) {
    throw new AppError("validation_error", "Invalid bank id", 400);
  }
  const bid = new Types.ObjectId(bankId);
  const bank = await BankModel.findById(bid).select("_id").lean();
  if (!bank) throw new AppError("not_found", "Bank not found", 404);
  const m = await computeClosingBalanceActualByBankIds([bid]);
  return { systemClosingBalance: Number(m.get(bankId) ?? 0) };
}

export async function listBankSettlements(bankId: string) {
  if (!Types.ObjectId.isValid(bankId)) {
    throw new AppError("validation_error", "Invalid bank id", 400);
  }
  const bid = new Types.ObjectId(bankId);
  const bank = await BankModel.findById(bid).select("_id").lean();
  if (!bank) throw new AppError("not_found", "Bank not found", 404);
  return BankBalanceSettlementModel.find({ bankId: bid })
    .sort({ effectiveAt: -1 })
    .limit(100)
    .populate("createdBy", "fullName username")
    .lean();
}

export async function createBankSettlement(
  bankId: string,
  input: CreateBankSettlementInput,
  actorId: string,
  requestId?: string,
) {
  if (!Types.ObjectId.isValid(bankId)) {
    throw new AppError("validation_error", "Invalid bank id", 400);
  }
  const bid = new Types.ObjectId(bankId);
  const bank = await BankModel.findById(bid).lean();
  if (!bank) throw new AppError("not_found", "Bank not found", 404);

  const master = Number(input.masterReportedBalance);
  if (!Number.isFinite(master) || master < 0) {
    throw new AppError("validation_error", "masterReportedBalance must be a non-negative finite number", 400);
  }

  const closingMap = await computeClosingBalanceActualByBankIds([bid]);
  const systemBalanceBefore = Number(closingMap.get(bankId) ?? 0);
  const signedAmount = master - systemBalanceBefore;
  if (!Number.isFinite(signedAmount) || Math.abs(signedAmount) < 1e-9) {
    throw new AppError(
      "business_rule_error",
      "Nothing to settle: master balance already matches the system-computed balance.",
      400,
    );
  }

  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new AppError("validation_error", "Reason must be at least 3 characters", 400);
  }

  const doc = await BankBalanceSettlementModel.create({
    bankId: bid,
    effectiveAt: input.effectiveAt,
    masterReportedBalance: master,
    signedAmount,
    systemBalanceBefore,
    reason,
    createdBy: new Types.ObjectId(actorId),
  });

  await BankModel.updateOne({ _id: bid }, { $set: { currentBalance: master } });

  await createAuditLog({
    actorId,
    action: "bank.settlement.create",
    entity: "bank",
    entityId: bankId,
    newValue: {
      masterReportedBalance: master,
      signedAmount,
      systemBalanceBefore,
      reason,
      effectiveAt: input.effectiveAt.toISOString(),
      settlementId: doc._id.toString(),
    },
    requestId,
  });

  return doc.toObject();
}
