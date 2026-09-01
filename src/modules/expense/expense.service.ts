import { Types } from "mongoose";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import type { z } from "zod";
import { REASON_TYPES } from "../../shared/constants/reasonTypes";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { BankModel } from "../bank/bank.model";
import { bankDisplayName as formatBankDisplayName } from "../bank/bank.constants";
import { ExpenseTypeModel } from "../masters/expense-type.model";
import { composeRejectReasonText, loadActiveReasonForReject } from "../reason/reasonLookup.service";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { createLiabilityEntry, deleteLiabilityEntryForReversal } from "../liability/liability.service";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  formatDateTimeForTimeZone,
  ymdToUtcEnd,
  ymdToUtcNoon,
  ymdToUtcStart,
} from "../../shared/utils/timezone";
import { ExpenseModel, ExpenseStatus } from "./expense.model";
import {
  approveExpenseBodySchema,
  cancelExpenseBodySchema,
  listExpenseQuerySchema,
} from "./expense.validation";
import { deleteFile, getSignedUrl, uploadFile } from "../../shared/services/bucket.service";
import { resolveMoneyFromRequest } from "../../shared/utils/moneyFx";
import { getCurrencyMinUnit } from "../../shared/constants/currencies";
import { requirePlatformCurrency } from "../settings/settings.service";

type CancelExpenseInput = z.infer<typeof cancelExpenseBodySchema>;

type ListExpenseQuery = z.infer<typeof listExpenseQuerySchema>;
type ApproveExpenseInput = z.infer<typeof approveExpenseBodySchema>;

function pageSizeFromQuery(q: ListExpenseQuery): number {
  return q.limit ?? q.pageSize;
}

function bankDisplayName(b: { holderName: string; bankName: string; accountNumber: string }): string {
  return formatBankDisplayName(b);
}

function parseYmdToDate(ymd: string, timeZone: string = DEFAULT_TIMEZONE): Date {
  return ymdToUtcNoon(ymd, timeZone) ?? new Date(ymd);
}

function trimUndef(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t === "" ? undefined : t;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Date filter for `expenseDate` (aligned with deposit `createdAtCondition`; default op equals when a single bound is used). */
function expenseDateCondition(
  from: string | undefined,
  to: string | undefined,
  op: string | undefined,
  timeZone: string,
): Record<string, unknown> | null {
  const f = trimUndef(from);
  const t = trimUndef(to);
  const rawOp = trimUndef(op);
  const effectiveOp =
    rawOp || (f && t ? "inRange" : f || t ? "equals" : "");

  if (effectiveOp === "inRange" && f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { expenseDate: { $gte: start, $lte: end } };
  }
  if (effectiveOp === "equals" && f) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(f, timeZone);
    if (!start || !end) return null;
    return { expenseDate: { $gte: start, $lte: end } };
  }
  if (effectiveOp === "before" && f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { expenseDate: { $lt: start } };
  }
  if (effectiveOp === "after" && f) {
    const end = ymdToUtcEnd(f, timeZone);
    if (!end) return null;
    return { expenseDate: { $gt: end } };
  }
  if (f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { expenseDate: { $gte: start, $lte: end } };
  }
  if (f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { expenseDate: { $gte: start } };
  }
  if (t) {
    const end = ymdToUtcEnd(t, timeZone);
    if (!end) return null;
    return { expenseDate: { $lte: end } };
  }
  return null;
}

function buildListFilter(q: ListExpenseQuery, timeZone: string): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];

  const search = trimUndef(q.search);
  if (search) {
    const esc = escapeRegex(search);
    conditions.push({
      $or: [
        { description: { $regex: esc, $options: "i" } },
        { bankName: { $regex: esc, $options: "i" } },
        { rejectReason: { $regex: esc, $options: "i" } },
      ],
    });
  }

  const st = trimUndef(q.status);
  if (st === "pending_audit" || st === "approved" || st === "rejected" || st === "cancelled") {
    conditions.push({ status: st as ExpenseStatus });
  }

  const expenseTypeId = trimUndef(q.expenseTypeId);
  if (expenseTypeId && Types.ObjectId.isValid(expenseTypeId)) {
    conditions.push({ expenseTypeId: new Types.ObjectId(expenseTypeId) });
  }

  const bankId = trimUndef(q.bankId);
  if (bankId && Types.ObjectId.isValid(bankId)) {
    conditions.push({ bankId: new Types.ObjectId(bankId) });
  }

  const dateCond = expenseDateCondition(
    trimUndef(q.expenseDate_from),
    trimUndef(q.expenseDate_to),
    trimUndef(q.expenseDate_op),
    timeZone,
  );
  if (dateCond) conditions.push(dateCond);

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

export async function createExpense(
  input: {
    expenseTypeId: string;
    amount: number;
    expenseDate: string;
    description?: string;
    bankId?: string;
    liabilityPersonId?: string;
    operatedCurrency?: string;
    operatedAmount?: number;
    exchangeRate?: number;
  },
  actorId: string,
  requestId?: string,
) {
  const et = await ExpenseTypeModel.findById(input.expenseTypeId);
  if (!et || et.deletedAt) throw new AppError("not_found", "Expense type not found", 404);
  if (!et.isActive) throw new AppError("business_rule_error", "Expense type is inactive", 400);

  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: getCurrencyMinUnit(await requirePlatformCurrency()) },
  );

  const skipAudit = et.auditRequired === false;
  const bankIdTrim = trimUndef(input.bankId);
  const liabilityPersonIdTrim = trimUndef(input.liabilityPersonId);
  const hasBank = Boolean(bankIdTrim);
  const hasPerson = Boolean(liabilityPersonIdTrim);

  if (skipAudit) {
    if (hasBank && hasPerson) {
      throw new AppError(
        "business_rule_error",
        "Provide either bank or liability person for settlement, not both",
        400,
      );
    }
    if (!hasBank && !hasPerson) {
      throw new AppError(
        "business_rule_error",
        "This expense type skips audit: choose settlement from a bank or a liability person",
        400,
      );
    }
  }

  let bankName = "";
  let bankObjectId: Types.ObjectId | undefined;
  if (bankIdTrim) {
    const bank = await BankModel.findById(bankIdTrim);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);
    bankObjectId = bank._id;
    bankName = bankDisplayName(bank);
  }

  const doc = await ExpenseModel.create({
    expenseTypeId: new Types.ObjectId(input.expenseTypeId),
    amount: money.amount,
    operatedCurrency: money.operatedCurrency,
    operatedAmount: money.operatedAmount,
    exchangeRate: money.exchangeRate,
    expenseDate: parseYmdToDate(input.expenseDate),
    description: input.description?.trim() ?? "",
    bankId: bankObjectId,
    bankName,
    status: "pending_audit" as const,
    createdBy: new Types.ObjectId(actorId),
  });

  await createAuditLog({
    actorId,
    action: "expense.create",
    entity: "expense",
    entityId: doc._id.toString(),
    newValue: {
      expenseTypeId: input.expenseTypeId,
      amount: money.amount,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
      expenseDate: input.expenseDate,
      bankId: bankIdTrim,
      liabilityPersonId: liabilityPersonIdTrim,
    } as unknown as Record<string, unknown>,
    requestId,
  });

  if (!skipAudit) {
    return doc;
  }

  const expenseId = doc._id.toString();

  if (hasBank && bankIdTrim) {
    return approveExpense(
      expenseId,
      { settlementAccountType: "bank", bankId: bankIdTrim },
      actorId,
      requestId,
    );
  }

  return approveExpense(
    expenseId,
    { settlementAccountType: "person", liabilityPersonId: liabilityPersonIdTrim! },
    actorId,
    requestId,
  );
}

export async function updateExpense(
  id: string,
  input: {
    expenseTypeId?: string;
    amount?: number;
    expenseDate?: string;
    description?: string;
    bankId?: string | null;
    operatedCurrency?: string;
    operatedAmount?: number;
    exchangeRate?: number;
  },
  actorId: string,
  requestId?: string,
) {
  const doc = await ExpenseModel.findById(id);
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  if (doc.status !== "pending_audit") {
    throw new AppError("business_rule_error", "Only pending expenses can be edited", 400);
  }

  const prev = {
    expenseTypeId: doc.expenseTypeId.toString(),
    amount: doc.amount,
    expenseDate: doc.expenseDate,
    description: doc.description,
    bankId: doc.bankId?.toString(),
  };

  if (input.expenseTypeId !== undefined) {
    const et = await ExpenseTypeModel.findById(input.expenseTypeId);
    if (!et || et.deletedAt) throw new AppError("not_found", "Expense type not found", 404);
    if (!et.isActive) throw new AppError("business_rule_error", "Expense type is inactive", 400);
    doc.expenseTypeId = new Types.ObjectId(input.expenseTypeId);
  }

  if (input.amount !== undefined) {
    const money = await resolveMoneyFromRequest(
      {
        amount: input.amount,
        operatedCurrency: input.operatedCurrency,
        operatedAmount: input.operatedAmount,
        exchangeRate: input.exchangeRate,
      },
      { minPlatformAmount: getCurrencyMinUnit(await requirePlatformCurrency()) },
    );
    doc.amount = money.amount;
    doc.operatedCurrency = money.operatedCurrency;
    doc.operatedAmount = money.operatedAmount;
    doc.exchangeRate = money.exchangeRate;
  }
  if (input.expenseDate !== undefined) doc.expenseDate = parseYmdToDate(input.expenseDate);
  if (input.description !== undefined) doc.description = input.description.trim();

  if (input.bankId !== undefined) {
    if (input.bankId === "" || input.bankId === null) {
      doc.bankId = undefined;
      doc.bankName = "";
    } else {
      const bank = await BankModel.findById(input.bankId);
      if (!bank) throw new AppError("not_found", "Bank not found", 404);
      if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);
      doc.bankId = bank._id;
      doc.bankName = bankDisplayName(bank);
    }
  }

  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();

  await createAuditLog({
    actorId,
    action: "expense.update",
    entity: "expense",
    entityId: doc._id.toString(),
    oldValue: prev as unknown as Record<string, unknown>,
    newValue: {
      expenseTypeId: doc.expenseTypeId.toString(),
      amount: doc.amount,
      operatedCurrency: doc.operatedCurrency,
      operatedAmount: doc.operatedAmount,
      exchangeRate: doc.exchangeRate,
      expenseDate: doc.expenseDate,
      description: doc.description,
      bankId: doc.bankId?.toString(),
    },
    requestId,
  });

  return doc;
}

export async function approveExpense(
  id: string,
  input: ApproveExpenseInput,
  actorId: string,
  requestId?: string,
) {
  const doc = await ExpenseModel.findById(id);
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  if (doc.status !== "pending_audit") {
    throw new AppError("business_rule_error", "Expense is not pending audit", 400);
  }

  const amount = doc.amount;
  if (input.settlementAccountType === "bank") {
    const bank = await BankModel.findById(input.bankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);

    const prevBal = bank.currentBalance ?? bank.openingBalance;
    if (amount > prevBal) {
      throw new AppError("business_rule_error", "Insufficient bank balance for this expense", 400);
    }

    const bankBalanceAfter = prevBal - amount;
    bank.currentBalance = bankBalanceAfter;
    await bank.save();

    try {
      doc.bankId = bank._id;
      doc.bankName = bankDisplayName(bank);
      doc.settlementAccountType = "bank";
      doc.liabilityPersonId = undefined;
      doc.liabilityPersonName = "";
      doc.liabilityEntryId = undefined;
      doc.status = "approved";
      doc.approvedBy = new Types.ObjectId(actorId);
      doc.approvedAt = new Date();
      doc.bankBalanceAfter = bankBalanceAfter;
      doc.updatedBy = new Types.ObjectId(actorId);
      await doc.save();
    } catch (err) {
      bank.currentBalance = prevBal;
      await bank.save();
      throw err;
    }

    await createAuditLog({
      actorId,
      action: "expense.approve",
      entity: "expense",
      entityId: doc._id.toString(),
      newValue: {
        settlementAccountType: "bank",
        bankId: input.bankId,
        bankBalanceAfter,
        amount,
      },
      requestId,
    });
    return doc;
  }

  const person = await LiabilityPersonModel.findById(input.liabilityPersonId);
  if (!person) throw new AppError("not_found", "Liability person not found", 404);
  if (!person.isActive) throw new AppError("business_rule_error", "Liability person is inactive", 400);

  const prevBankId = doc.bankId;
  const prevBankName = doc.bankName;

  doc.settlementAccountType = "person";
  doc.liabilityPersonId = person._id;
  doc.liabilityPersonName = person.name;
  doc.liabilityEntryId = undefined;
  doc.bankId = undefined;
  doc.bankName = "";
  doc.status = "approved";
  doc.approvedBy = new Types.ObjectId(actorId);
  doc.approvedAt = new Date();
  doc.bankBalanceAfter = undefined;
  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();

  try {
    const referenceNo = `EXP-${String(doc._id).slice(-8).toUpperCase()}`;
    /** Match business calendar (same as createExpense `parseYmdToDate`); UTC `toISOString` slice can shift the day vs ledger filters. */
    const liabilityEntryYmd =
      formatDateForTimeZone(doc.expenseDate, DEFAULT_TIMEZONE) || doc.expenseDate.toISOString().slice(0, 10);
    const liabilityEntry = await createLiabilityEntry(
      {
        entryDate: liabilityEntryYmd,
        entryType: "journal",
        amount: doc.amount,
        fromAccountType: "person",
        fromAccountId: String(person._id),
        toAccountType: "expense",
        toAccountId: String(doc._id),
        sourceType: "expense",
        sourceExpenseId: String(doc._id),
        referenceNo,
        remark: `Expense settlement for ${String(doc._id)}`,
      },
      actorId,
      requestId,
    );

    doc.liabilityEntryId = liabilityEntry._id;
    doc.updatedBy = new Types.ObjectId(actorId);
    await doc.save();
  } catch (err) {
    doc.status = "pending_audit";
    doc.approvedBy = undefined;
    doc.approvedAt = undefined;
    doc.settlementAccountType = undefined;
    doc.liabilityPersonId = undefined;
    doc.liabilityPersonName = "";
    doc.liabilityEntryId = undefined;
    doc.bankId = prevBankId;
    doc.bankName = prevBankName ?? "";
    doc.updatedBy = new Types.ObjectId(actorId);
    await doc.save();
    throw err;
  }

  await createAuditLog({
    actorId,
    action: "expense.approve",
    entity: "expense",
    entityId: doc._id.toString(),
    newValue: {
      settlementAccountType: "person",
      liabilityPersonId: input.liabilityPersonId,
      liabilityEntryId: doc.liabilityEntryId?.toString(),
      amount,
    },
    requestId,
  });

  return doc;
}

export async function rejectExpense(
  id: string,
  input: { reasonId: string; remark?: string },
  actorId: string,
  requestId?: string,
) {
  const resolved = await loadActiveReasonForReject(input.reasonId, REASON_TYPES.EXPENSE_AUDIT_REJECT);
  const rejectText = composeRejectReasonText(resolved.masterText, input.remark);

  const doc = await ExpenseModel.findById(id);
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  if (doc.status !== "pending_audit") {
    throw new AppError("business_rule_error", "Expense is not pending audit", 400);
  }

  doc.status = "rejected";
  doc.rejectReason = rejectText;
  doc.rejectReasonId = new Types.ObjectId(resolved.id);
  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();

  await createAuditLog({
    actorId,
    action: "expense.reject",
    entity: "expense",
    entityId: doc._id.toString(),
    newValue: {
      rejectReason: rejectText,
      rejectReasonId: resolved.id,
      remark: input.remark?.trim() || undefined,
    },
    requestId,
  });

  return doc;
}

export async function cancelApprovedExpense(
  id: string,
  input: CancelExpenseInput,
  actorId: string,
  requestId?: string,
) {
  const resolved = await loadActiveReasonForReject(input.reasonId, REASON_TYPES.EXPENSE_CANCEL);
  const cancelText = composeRejectReasonText(resolved.masterText, input.remark);

  const doc = await ExpenseModel.findById(id);
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  if (doc.status !== "approved") {
    throw new AppError("business_rule_error", "Only approved expenses can be cancelled", 400);
  }

  const amount = doc.amount;
  const oldValue = {
    status: doc.status,
    amount,
    settlementAccountType: doc.settlementAccountType,
    bankId: doc.bankId?.toString(),
    bankName: doc.bankName,
    liabilityPersonId: doc.liabilityPersonId?.toString(),
    liabilityEntryId: doc.liabilityEntryId?.toString(),
    bankBalanceAfter: doc.bankBalanceAfter,
  };

  let bankReversalMeta: {
    bankId?: string;
    previousBalance?: number;
    nextBalance?: number;
    delta?: number;
  } = {};
  let rollbackBank: (() => Promise<void>) | null = null;
  const liabilityEntryIdBefore = doc.liabilityEntryId ? String(doc.liabilityEntryId) : undefined;

  if (doc.settlementAccountType === "bank") {
    if (!doc.bankId) {
      throw new AppError("business_rule_error", "Approved bank expense has no bank linked", 400);
    }
    const bank = await BankModel.findById(doc.bankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);

    const prevBal = bank.currentBalance ?? bank.openingBalance;
    const nextBal = prevBal + amount;
    bank.currentBalance = nextBal;
    await bank.save();

    bankReversalMeta = {
      bankId: String(bank._id),
      previousBalance: prevBal,
      nextBalance: nextBal,
      delta: amount,
    };
    rollbackBank = async () => {
      bank.currentBalance = prevBal;
      await bank.save();
    };
  } else if (doc.settlementAccountType === "person") {
    if (!doc.liabilityEntryId) {
      throw new AppError(
        "business_rule_error",
        "Approved person-settled expense has no liability entry linked",
        400,
      );
    }
    await deleteLiabilityEntryForReversal(String(doc.liabilityEntryId), actorId, requestId);
  } else {
    throw new AppError("business_rule_error", "Approved expense has no settlement type", 400);
  }

  try {
    doc.status = "cancelled";
    doc.cancelReason = cancelText;
    doc.cancelReasonId = new Types.ObjectId(resolved.id);
    doc.cancelledBy = new Types.ObjectId(actorId);
    doc.cancelledAt = new Date();
    doc.liabilityEntryId = undefined;
    doc.updatedBy = new Types.ObjectId(actorId);
    await doc.save();
  } catch (err) {
    if (rollbackBank) await rollbackBank();
    if (doc.settlementAccountType === "person" && liabilityEntryIdBefore) {
      throw new AppError(
        "business_rule_error",
        "Expense cancel failed after liability reversal; contact support",
        500,
      );
    }
    throw err;
  }

  await createAuditLog({
    actorId,
    action: "expense.cancel",
    entity: "expense",
    entityId: doc._id.toString(),
    oldValue: oldValue as unknown as Record<string, unknown>,
    newValue: {
      status: "cancelled",
      cancelReason: cancelText,
      cancelReasonId: resolved.id,
      remark: input.remark?.trim() || undefined,
      reversal: {
        settlementAccountType: doc.settlementAccountType,
        bank: bankReversalMeta,
        liabilityEntryId: liabilityEntryIdBefore,
      },
    },
    requestId,
  });

  return doc;
}

export async function listExpenses(query: ListExpenseQuery, options?: { timeZone?: string }) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildListFilter(query, timeZone);
  const page = query.page;
  const pageSize = pageSizeFromQuery(query);
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    ExpenseModel.find(filter)
      .populate("expenseTypeId", "name code isActive")
      .populate("bankId", "holderName bankName accountNumber")
      .populate("liabilityPersonId", "name")
      .populate("liabilityEntryId", "entryType amount entryDate sourceType sourceExpenseId")
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
    meta: {
      total,
      page,
      pageSize,
    },
  };
}

const EXPORT_MAX_ROWS = 10_000;

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

export async function exportExpensesToBuffer(
  query: ListExpenseQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildListFilter(query, timeZone);
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const rows = await ExpenseModel.find(filter)
    .populate("expenseTypeId", "name code")
    .populate("bankId", "holderName bankName accountNumber")
    .populate("liabilityPersonId", "name")
    .populate("createdBy", "fullName username")
    .populate("approvedBy", "fullName username")
    .populate("cancelledBy", "fullName username")
    .sort({ [query.sortBy]: sortValue })
    .limit(EXPORT_MAX_ROWS)
    .lean();

  const exportData = rows.map((r) => {
    const et = r.expenseTypeId as { name?: string; code?: string } | null;
    const b = r.bankId as { holderName?: string; bankName?: string; accountNumber?: string } | null;
    const p = r.liabilityPersonId as { name?: string } | null;

    let settlement = "";
    if (r.settlementAccountType === "bank" && b) {
      settlement = `Bank: ${b.holderName} (${b.bankName})`;
    } else if (r.settlementAccountType === "person" && p) {
      settlement = `Person: ${p.name}`;
    }

    return {
      "Expense Date": formatDateForTimeZone(r.expenseDate, timeZone),
      Type: et?.name ?? "",
      Amount: r.amount,
      Description: r.description ?? "",
      Status: r.status,
      "Settlement Via": settlement,
      "Reject Reason": r.rejectReason ?? "",
      "Cancel Reason": r.cancelReason ?? "",
      "Created By": formatUserForExport(r.createdBy),
      "Approved By": formatUserForExport(r.approvedBy),
      "Cancelled By": formatUserForExport(r.cancelledBy),
      "Created At": formatDateTimeForTimeZone(r.createdAt, timeZone),
    };
  });

  return generateExcelBuffer(exportData, "Expenses");
}

export async function listActiveExpenseTypes() {
  const rows = await ExpenseTypeModel.find({
    isActive: true,
    deletedAt: null,
  })
    .sort({ name: 1 })
    .select("_id name code description auditRequired")
    .lean();
  return rows;
}

export async function getExpenseById(id: string) {
  const doc = await ExpenseModel.findById(id)
    .populate("expenseTypeId", "name code isActive")
    .populate("bankId", "holderName bankName accountNumber ifsc")
    .populate("liabilityPersonId", "name")
    .populate("liabilityEntryId", "entryType amount entryDate sourceType sourceExpenseId")
    .populate("createdBy", "fullName username")
    .populate("approvedBy", "fullName username")
    .populate("cancelledBy", "fullName username")
    .lean();
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  return doc;
}

type UploadableFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size?: number;
};

export async function uploadExpenseDocuments(
  id: string,
  files: UploadableFile[],
  actorId: string,
  requestId?: string,
) {
  const doc = await ExpenseModel.findById(id);
  if (!doc) throw new AppError("not_found", "Expense not found", 404);
  const canUpload =
    doc.status === "pending_audit" ||
    (doc.status === "approved" && (!doc.documents || doc.documents.length === 0));
  if (!canUpload) {
    throw new AppError(
      "business_rule_error",
      "Documents can only be added while pending audit, or once when the expense was auto-approved and has no documents yet",
      400,
    );
  }
  if (!files || files.length === 0) {
    throw new AppError("validation_error", "At least one document is required", 400);
  }

  const uploaded: Array<{
    path: string;
    filename: string;
    size: number;
    mime_type: string;
    uploaded_at: string;
  }> = [];
  try {
    for (const file of files) {
      const uploadedFile = await uploadFile(file, {
        prefix: `expenses/${id}`,
        acl: "private",
      });
      uploaded.push(uploadedFile);
    }
  } catch (error) {
    await Promise.all(
      uploaded.map(async (f) => {
        try {
          await deleteFile(f.path);
        } catch {
          // Ignore cleanup errors and surface original upload failure.
        }
      }),
    );
    throw error;
  }

  const normalized = uploaded.map((f) => ({
    path: f.path,
    filename: f.filename,
    size: f.size,
    mime_type: f.mime_type,
    uploaded_at: new Date(f.uploaded_at),
  }));

  doc.documents = [...(doc.documents || []), ...normalized];
  doc.updatedBy = new Types.ObjectId(actorId);
  await doc.save();

  await createAuditLog({
    actorId,
    action: "expense.documents_upload",
    entity: "expense",
    entityId: doc._id.toString(),
    newValue: {
      uploadedCount: normalized.length,
      documents: normalized.map((d) => ({
        path: d.path,
        filename: d.filename,
        size: d.size,
        mime_type: d.mime_type,
      })),
    },
    requestId,
  });

  return doc;
}

export async function getExpenseDocumentSignedUrl(id: string, docIndex: number) {
  const doc = await ExpenseModel.findById(id).select("documents").lean();
  if (!doc) throw new AppError("not_found", "Expense not found", 404);

  const documents = Array.isArray(doc.documents) ? doc.documents : [];
  if (docIndex < 0 || docIndex >= documents.length) {
    throw new AppError("not_found", "Document not found", 404);
  }

  const target = documents[docIndex];
  const url = await getSignedUrl(target.path);
  return {
    url,
    filename: target.filename,
    mime_type: target.mime_type,
    uploaded_at: target.uploaded_at,
  };
}
