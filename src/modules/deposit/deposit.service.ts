import { Types, type HydratedDocument } from "mongoose";
import type { z } from "zod";
import xlsx from "xlsx";
import { generateExcelBuffer } from "../../shared/services/excel.service";
import {
  formatImportDateTimeForDisplay,
  importPickRaw,
  isImportDateTimePresent,
  parseImportDateTime,
} from "../../shared/utils/importDateTime";
import {
  buildBankResolutionCache,
  buildExchangePlayerResolutionCache,
  buildPersonResolutionCache,
  loadBanksForImportIdentifiers,
  loadLiabilityPersonsForImportNames,
  loadPlayersForImportPlayerIds,
} from "./deposit-import-resolve";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { BankModel } from "../bank/bank.model";
import { bankDisplayName as formatBankDisplayName } from "../bank/bank.constants";
import { PlayerModel } from "../player/player.model";
import { REASON_TYPES } from "../../shared/constants/reasonTypes";
import { composeRejectReasonText, loadActiveReasonForReject } from "../reason/reasonLookup.service";
import {
  DEFAULT_TIMEZONE,
  formatDateForTimeZone,
  formatDateTimeForTimeZone,
  ymdToUtcEnd,
  ymdToUtcStart,
} from "../../shared/utils/timezone";
import type { DepositAmendmentSnapshot, DepositDocument } from "./deposit.model";
import { DepositModel, DepositStatus } from "./deposit.model";
import {
  amendDepositBodySchema,
  createDepositBodySchema,
  exportDepositQuerySchema,
  listDepositQuerySchema,
  updateDepositBodySchema,
} from "./deposit.validation";
import { emitApprovalQueueEvent } from "../approval/approval-queue-events";
import {
  cancelReferralAccrualForDeposit,
  ensureDepositReferralAccrualMutable,
  syncReferralAccrualForDeposit,
} from "../referral/referral.service";
import { decodeTimeCursor, encodeTimeCursor } from "../../shared/utils/cursorPagination";
import { enqueueExchangeRecompute } from "../../shared/queue/queue";
import { invalidateCacheDomains } from "../../shared/cache/domainCache";
import { logger } from "../../shared/logger";
import { normalizeUtr } from "../../shared/utils/utr";
import { createLiabilityEntry, deleteLiabilityEntryForReversal } from "../liability/liability.service";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { chunkArray } from "../../shared/utils/chunkArray";
import { resolveMoneyFromRequest, convertSecondaryAmount, roundMoneyToCurrency, resolveMoneyInput } from "../../shared/utils/moneyFx";
import { getCurrencyMinUnit, isSupportedCurrency, type SupportedCurrency } from "../../shared/constants/currencies";
import { requirePlatformCurrency } from "../settings/settings.service";
import { resolveMasterExchangeRate } from "../lookup/exchange-rate-lookup.service";
import {
  buildTransactionDuplicateKey,
  DUPLICATE_TRANSACTION_MESSAGE,
  ensureNoDuplicateTransaction,
  findDuplicateTransaction,
} from "../../shared/utils/transactionDuplicate";

export const DEPOSIT_IMPORT_CHUNK_SIZE = 100;

type ListDepositQuery = z.infer<typeof listDepositQuerySchema>;
type ExportDepositQuery = z.infer<typeof exportDepositQuerySchema>;
type AmendDepositInput = z.infer<typeof amendDepositBodySchema>;
type BankerDepositUpdateInput = z.infer<typeof updateDepositBodySchema>;
type CreateDepositBody = z.infer<typeof createDepositBodySchema>;

type CreateDepositInput = CreateDepositBody & {
  playerMongoId?: string;
  totalAmount?: number;
};

type DepositServiceOptions = { timeZone?: string };

async function assertDepositTransactionNotDuplicate(params: {
  playerId: string | Types.ObjectId;
  settlementType: "bank" | "person";
  settlementAccountId: string | Types.ObjectId;
  amount: number;
  transactionAt: Date;
  utr: string;
  timeZone?: string;
  excludeDepositId?: Types.ObjectId;
}) {
  await ensureNoDuplicateTransaction({
    playerId: params.playerId,
    settlementType: params.settlementType,
    settlementAccountId: params.settlementAccountId,
    amount: params.amount,
    transactionAt: params.transactionAt,
    utr: params.utr,
    timeZone: params.timeZone ?? DEFAULT_TIMEZONE,
    excludeDepositId: params.excludeDepositId,
  });
}

function buildDepositDuplicateKey(params: {
  playerId: string | Types.ObjectId;
  settlementType: "bank" | "person";
  settlementAccountId: string | Types.ObjectId;
  amount: number;
  transactionAt: Date;
  utr: string;
  timeZone?: string;
}): string {
  return buildTransactionDuplicateKey({
    playerId: params.playerId,
    settlementType: params.settlementType,
    settlementAccountId: params.settlementAccountId,
    amount: params.amount,
    transactionAt: params.transactionAt,
    utr: params.utr,
    timeZone: params.timeZone ?? DEFAULT_TIMEZONE,
  });
}

function pageSizeFromQuery(q: ListDepositQuery): number {
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

function parseBusinessDateTime(value: string | undefined, fieldName: string): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("validation_error", `${fieldName} must be a valid datetime`, 400);
  }
  return parsed;
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

function transactionDateCondition(
  from: string | undefined,
  to: string | undefined,
  op: string | undefined,
  timeZone: string,
): Record<string, unknown> | null {
  const txExpr = { $ifNull: ["$entryAt", "$createdAt"] };
  const operator = op || "inRange";
  const f = trimUndef(from);
  const t = trimUndef(to);

  if (operator === "inRange" && f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { $expr: { $and: [{ $gte: [txExpr, start] }, { $lte: [txExpr, end] }] } };
  }
  if (operator === "equals" && f) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(f, timeZone);
    if (!start || !end) return null;
    return { $expr: { $and: [{ $gte: [txExpr, start] }, { $lte: [txExpr, end] }] } };
  }
  if (operator === "before" && f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { $expr: { $lt: [txExpr, start] } };
  }
  if (operator === "after" && f) {
    const end = ymdToUtcEnd(f, timeZone);
    if (!end) return null;
    return { $expr: { $gt: [txExpr, end] } };
  }
  if (f && t) {
    const start = ymdToUtcStart(f, timeZone);
    const end = ymdToUtcEnd(t, timeZone);
    if (!start || !end) return null;
    return { $expr: { $and: [{ $gte: [txExpr, start] }, { $lte: [txExpr, end] }] } };
  }
  if (f) {
    const start = ymdToUtcStart(f, timeZone);
    if (!start) return null;
    return { $expr: { $gte: [txExpr, start] } };
  }
  if (t) {
    const end = ymdToUtcEnd(t, timeZone);
    if (!end) return null;
    return { $expr: { $lte: [txExpr, end] } };
  }
  return null;
}

function buildDepositListFilter(q: ExportDepositQuery, timeZone: string): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];

  // IB commission settle used to create bonus deposits; never show them in deposit queues.
  conditions.push({ isReferralSettlement: { $ne: true } });

  const search = trimUndef(q.search);
  if (search) {
    const esc = escapeRegex(search);
    conditions.push({
      $or: [
        { utr: { $regex: esc, $options: "i" } },
        { bankName: { $regex: esc, $options: "i" } },
        { liabilityPersonName: { $regex: esc, $options: "i" } },
      ],
    });
  }

  let statusFilter = trimUndef(q.status);
  /** `all` = no status constraint (banker/exchange). Missing/empty still defaults to pending below. */
  const statusShowAll = statusFilter === "all";
  if (!statusShowAll && statusFilter == null && (q.view === "banker" || q.view === "exchange")) {
    statusFilter = "pending";
  }
  if (
    !statusShowAll &&
    (statusFilter === "pending" ||
      statusFilter === "not_settled" ||
      statusFilter === "verified" ||
      statusFilter === "rejected" ||
      statusFilter === "finalized")
  ) {
    conditions.push({ status: statusFilter });
  }

  const utr = trimUndef(q.utr);
  if (utr) {
    conditions.push(textFieldCondition("utr", utr, trimUndef(q.utr_op)));
  }

  const bankName = trimUndef(q.bankName);
  if (bankName) {
    conditions.push(textFieldCondition("bankName", bankName, trimUndef(q.bankName_op)));
  }

  const bankId = trimUndef(q.bankId);
  if (bankId && Types.ObjectId.isValid(bankId)) {
    conditions.push({ bankId: new Types.ObjectId(bankId) });
  }

  const player = trimUndef(q.player);
  if (player && Types.ObjectId.isValid(player)) {
    conditions.push({ player: new Types.ObjectId(player) });
  }

  const createdBy = trimUndef(q.createdBy);
  if (createdBy && Types.ObjectId.isValid(createdBy)) {
    conditions.push({ createdBy: new Types.ObjectId(createdBy) });
  }

  const dateCond = transactionDateCondition(
    trimUndef(q.createdAt_from),
    trimUndef(q.createdAt_to),
    trimUndef(q.createdAt_op),
    timeZone,
  );
  if (dateCond) {
    conditions.push(dateCond);
  }

  const hasAmendment = trimUndef(q.hasAmendment);
  if (hasAmendment === "yes") {
    conditions.push({
      $or: [{ amendmentCount: { $gt: 0 } }, { "amendmentHistory.0": { $exists: true } }],
    });
  } else if (hasAmendment === "no") {
    conditions.push({
      $nor: [{ amendmentCount: { $gt: 0 } }, { "amendmentHistory.0": { $exists: true } }],
    });
  }

  const amt = numberFieldCondition(
    "amount",
    trimUndef(q.amount),
    trimUndef(q.amount_op),
    trimUndef(q.amount_to),
  );
  if (amt) {
    conditions.push(amt);
  }

  const tot = numberFieldCondition(
    "totalAmount",
    trimUndef(q.totalAmount),
    trimUndef(q.totalAmount_op),
    trimUndef(q.totalAmount_to),
  );
  if (tot) {
    conditions.push(tot);
  }

  if (conditions.length === 0) {
    return {};
  }
  if (conditions.length === 1) {
    return conditions[0];
  }
  return { $and: conditions };
}

function bankDisplayName(b: { holderName: string; bankName: string; accountNumber: string }): string {
  return formatBankDisplayName(b);
}

async function resolveImportPlayerFields(input: CreateDepositInput): Promise<{
  player?: Types.ObjectId;
  bonusAmount?: number;
  totalAmount?: number;
}> {
  if (!input.playerMongoId?.trim()) return {};
  if (!Types.ObjectId.isValid(input.playerMongoId)) {
    throw new AppError("validation_error", "Invalid player reference", 400);
  }
  const player = await PlayerModel.findById(input.playerMongoId).select("_id").lean();
  if (!player) throw new AppError("not_found", "Player not found", 404);

  const platformCurrency = await requirePlatformCurrency();
  const rawBonus = Number(input.bonusAmount ?? 0);
  if (!Number.isFinite(rawBonus) || rawBonus < 0) {
    throw new AppError("validation_error", "Invalid bonus amount", 400);
  }
  const bonusRounded = roundMoneyToCurrency(rawBonus, platformCurrency);
  const totalAmount =
    input.totalAmount != null
      ? roundMoneyToCurrency(input.totalAmount, platformCurrency)
      : roundMoneyToCurrency(input.amount + bonusRounded, platformCurrency);

  return {
    player: new Types.ObjectId(input.playerMongoId),
    bonusAmount: bonusRounded,
    totalAmount,
  };
}

export async function createDeposit(
  input: CreateDepositInput,
  actorId: string,
  requestId?: string,
  options?: DepositServiceOptions,
) {
  const mode = input.settlementAccountType ?? "bank";
  const platformCurrency = await requirePlatformCurrency();
  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: getCurrencyMinUnit(platformCurrency) },
  );

  const playerId = (input.playerId || input.playerMongoId || "").trim();
  if (!playerId || !Types.ObjectId.isValid(playerId)) {
    throw new AppError("validation_error", "Player is required", 400);
  }
  const bonusAmount = Number(input.bonusAmount ?? 0);
  if (!Number.isFinite(bonusAmount) || bonusAmount < 0) {
    throw new AppError("validation_error", "Invalid bonus amount", 400);
  }

  const entryAt = parseBusinessDateTime(input.entryAt, "entryAt");
  const timeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  const settlementAccountId =
    mode === "bank" ? (input.bankId as string) : (input.liabilityPersonId as string);

  await assertDepositTransactionNotDuplicate({
    playerId,
    settlementType: mode,
    settlementAccountId,
    amount: money.amount,
    transactionAt: entryAt,
    utr: input.utr,
    timeZone,
  });

  const duplicateKey = buildDepositDuplicateKey({
    playerId,
    settlementType: mode,
    settlementAccountId,
    amount: money.amount,
    transactionAt: entryAt,
    utr: input.utr,
    timeZone,
  });

  const base = {
    utr: normalizeUtr(input.utr),
    amount: money.amount,
    operatedCurrency: money.operatedCurrency,
    operatedAmount: money.operatedAmount,
    exchangeRate: money.exchangeRate,
    status: "pending" as const,
    entryAt,
    createdBy: new Types.ObjectId(actorId),
    settlementAccountType: mode as "bank" | "person",
    duplicateKey,
  };

  let doc;
  if (mode === "bank") {
    const bankIdStr = input.bankId as string;
    const bank = await BankModel.findById(bankIdStr);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);

    doc = await DepositModel.create({
      ...base,
      bankId: new Types.ObjectId(bankIdStr),
      bankName: bankDisplayName(bank),
      bankImpact: true,
    });

    await createAuditLog({
      actorId,
      action: "deposit.create",
      entity: "deposit",
      entityId: doc._id.toString(),
      newValue: {
        settlementAccountType: "bank",
        bankId: bankIdStr,
        utr: base.utr,
        amount: money.amount,
        operatedCurrency: money.operatedCurrency,
        operatedAmount: money.operatedAmount,
        exchangeRate: money.exchangeRate,
        entryAt: doc.entryAt,
        playerId,
        bonusAmount,
      } as unknown as Record<string, unknown>,
      requestId,
    });
  } else {
    const personId = input.liabilityPersonId as string;
    const person = await LiabilityPersonModel.findById(personId).lean();
    if (!person) throw new AppError("not_found", "Liability person not found", 404);
    if (!person.isActive) throw new AppError("business_rule_error", "Liability person is inactive", 400);

    doc = await DepositModel.create({
      ...base,
      liabilityPersonId: new Types.ObjectId(personId),
      liabilityPersonName: person.name.trim(),
      bankImpact: false,
      bankName: "",
    });

    await createAuditLog({
      actorId,
      action: "deposit.create",
      entity: "deposit",
      entityId: doc._id.toString(),
      newValue: {
        settlementAccountType: "person",
        liabilityPersonId: personId,
        liabilityPersonName: doc.liabilityPersonName,
        utr: base.utr,
        amount: money.amount,
        operatedCurrency: money.operatedCurrency,
        operatedAmount: money.operatedAmount,
        exchangeRate: money.exchangeRate,
        entryAt: doc.entryAt,
        playerId,
        bonusAmount,
      } as unknown as Record<string, unknown>,
      requestId,
    });
  }

  // Single-stage: settle immediately to verified (bank/liability + referral side effects).
  try {
    return await exchangeApproveDeposit(
      doc._id.toString(),
      { playerId, bonusAmount: Math.round(bonusAmount) },
      actorId,
      requestId,
    );
  } catch (err) {
    await DepositModel.deleteOne({ _id: doc._id }).catch(() => undefined);
    throw err;
  }
}

export async function updateDepositByBanker(
  id: string,
  input: BankerDepositUpdateInput,
  actorId: string,
  requestId?: string,
  options?: DepositServiceOptions,
) {
  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  if (doc.status !== "pending") {
    throw new AppError("business_rule_error", "Only pending deposits can be updated", 400);
  }

  const utrTrim = normalizeUtr(input.utr);
  const platformCurrency = await requirePlatformCurrency();
  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: getCurrencyMinUnit(platformCurrency) },
  );

  const mode = input.settlementAccountType ?? "bank";
  const settlementAccountId =
    mode === "bank" ? (input.bankId as string) : (input.liabilityPersonId as string);
  const transactionAt = doc.entryAt ?? doc.createdAt;
  const playerIdForDup = doc.player;
  if (playerIdForDup) {
    await assertDepositTransactionNotDuplicate({
      playerId: playerIdForDup,
      settlementType: mode,
      settlementAccountId,
      amount: money.amount,
      transactionAt,
      utr: utrTrim,
      timeZone: options?.timeZone ?? DEFAULT_TIMEZONE,
      excludeDepositId: doc._id,
    });
  }

  const prev = {
    settlementAccountType: doc.settlementAccountType,
    bankId: doc.bankId?.toString(),
    bankName: doc.bankName,
    liabilityPersonId: doc.liabilityPersonId?.toString(),
    liabilityPersonName: doc.liabilityPersonName,
    utr: doc.utr,
    amount: doc.amount,
    bankImpact: doc.bankImpact,
  };

  if (mode === "bank") {
    const bankIdStr = input.bankId as string;
    const bank = await BankModel.findById(bankIdStr);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);

    doc.settlementAccountType = "bank";
    doc.bankId = new Types.ObjectId(bankIdStr);
    doc.bankName = bankDisplayName(bank);
    doc.liabilityPersonId = undefined;
    doc.liabilityPersonName = "";
    doc.bankImpact = true;
  } else {
    const personId = input.liabilityPersonId as string;
    const person = await LiabilityPersonModel.findById(personId).lean();
    if (!person) throw new AppError("not_found", "Liability person not found", 404);
    if (!person.isActive) throw new AppError("business_rule_error", "Liability person is inactive", 400);

    doc.settlementAccountType = "person";
    doc.bankId = undefined;
    doc.bankName = "";
    doc.liabilityPersonId = new Types.ObjectId(personId);
    doc.liabilityPersonName = person.name.trim();
    doc.bankImpact = false;
  }

  doc.utr = utrTrim;
  doc.amount = money.amount;
  doc.operatedCurrency = money.operatedCurrency;
  doc.operatedAmount = money.operatedAmount;
  doc.exchangeRate = money.exchangeRate;
  if (playerIdForDup) {
    doc.duplicateKey = buildDepositDuplicateKey({
      playerId: playerIdForDup,
      settlementType: mode,
      settlementAccountId:
        mode === "bank" ? String(doc.bankId) : String(doc.liabilityPersonId),
      amount: money.amount,
      transactionAt: doc.entryAt ?? doc.createdAt,
      utr: utrTrim,
      timeZone: options?.timeZone ?? DEFAULT_TIMEZONE,
    });
  }
  await doc.save();

  await createAuditLog({
    actorId,
    action: "deposit.banker_update",
    entity: "deposit",
    entityId: doc._id.toString(),
    oldValue: prev as unknown as Record<string, unknown>,
    newValue: {
      settlementAccountType: mode,
      bankId: mode === "bank" ? input.bankId : undefined,
      liabilityPersonId: mode === "person" ? input.liabilityPersonId : undefined,
      utr: utrTrim,
      amount: money.amount,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
    } as unknown as Record<string, unknown>,
    requestId,
  });

  emitApprovalQueueEvent("deposit", "exchange");
  return doc;
}

export type LastBankerDepositMeta = { bankId: string; bankName: string } | null;

async function lastBankerDepositForActor(
  view: ListDepositQuery["view"],
  actorId: string | undefined,
): Promise<LastBankerDepositMeta> {
  if (view !== "banker" || !actorId || !Types.ObjectId.isValid(actorId)) return null;
  const row = await DepositModel.findOne({
    createdBy: new Types.ObjectId(actorId),
    bankId: { $exists: true, $ne: null },
    $or: [{ settlementAccountType: { $exists: false } }, { settlementAccountType: "bank" }],
  })
    .sort({ createdAt: -1 })
    .select({ bankId: 1, bankName: 1 })
    .lean();
  if (!row) return null;
  const raw = row.bankId as unknown;
  const bankId =
    raw != null && typeof raw === "object" && "_id" in (raw as object)
      ? String((raw as { _id?: unknown })._id)
      : raw != null
        ? String(raw)
        : "";
  if (!bankId) return null;
  const bankName = typeof row.bankName === "string" ? row.bankName.trim() : "";
  return { bankId, bankName: bankName || "—" };
}

export async function listDeposits(
  query: ListDepositQuery,
  options?: { actorId?: string; timeZone?: string },
) {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildDepositListFilter(query, timeZone);
  const page = query.page;
  const pageSize = pageSizeFromQuery(query);
  const skip = (page - 1) * pageSize;
  const sortValue = query.sortOrder === "asc" ? 1 : -1;
  const sortField = query.sortBy;
  const supportsCursor = sortValue === -1 && (sortField === "entryAt" || sortField === "createdAt");
  const cursor = supportsCursor ? decodeTimeCursor(query.cursor) : null;
  const queryFilter: Record<string, unknown> = { ...filter };
  if (cursor) {
    const cursorDate = new Date(cursor.t);
    if (!Number.isNaN(cursorDate.getTime()) && Types.ObjectId.isValid(cursor.id)) {
      queryFilter.$or = [
        { [sortField]: { $lt: cursorDate } },
        { [sortField]: cursorDate, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }
  }

  const [rows, total, lastBankerDeposit] = await Promise.all([
    DepositModel.find(queryFilter)
      .populate("bankId", "holderName bankName accountNumber ifsc openingBalance currentBalance")
      .populate("liabilityPersonId", "name isActive")
      .populate("player", "playerId phone exchange")
      .populate("createdBy", "fullName username")
      .populate("exchangeActionBy", "fullName username")
      .populate("lastAmendedBy", "fullName username")
      .sort({ [sortField]: sortValue })
      .skip(cursor ? 0 : skip)
      .limit(pageSize)
      .lean(),
    DepositModel.countDocuments(filter),
    lastBankerDepositForActor(query.view, options?.actorId),
  ]);

  const meta: {
    page: number;
    pageSize: number;
    total: number;
    lastBankerDeposit?: LastBankerDepositMeta;
  } = {
    page,
    pageSize,
    total,
  };
  if (query.view === "banker") {
    meta.lastBankerDeposit = lastBankerDeposit;
  }
  const lastRow = rows[rows.length - 1] as { _id?: unknown; entryAt?: Date; createdAt?: Date } | undefined;
  if (cursor && lastRow?._id) {
    const ts = sortField === "entryAt" ? (lastRow.entryAt ?? lastRow.createdAt) : lastRow.createdAt;
    if (ts) {
      (meta as Record<string, unknown>).nextCursor = encodeTimeCursor({ t: ts, id: String(lastRow._id) });
    }
  }

  return {
    rows,
    meta,
  };
}

const EXPORT_MAX_ROWS = 10_000;

function formatUserForExport(u: unknown): string {
  if (u == null) return "";
  if (typeof u === "object" && u !== null && "_id" in u) {
    const x = u as { fullName?: string; username?: string };
    const fn = x.fullName?.trim();
    const un = x.username?.trim();
    if (fn && un) return `${fn} (${un})`;
    if (fn) return fn;
    if (un) return un;
  }
  return "";
}

export async function exportDepositsToBuffer(
  query: ExportDepositQuery,
  options?: { timeZone?: string },
): Promise<Buffer> {
  const timeZone = options?.timeZone || DEFAULT_TIMEZONE;
  const filter = buildDepositListFilter(query, timeZone);
  const sortValue = query.sortOrder === "asc" ? 1 : -1;

  const rows = await DepositModel.find(filter)
    .populate("bankId", "holderName bankName accountNumber")
    .populate("liabilityPersonId", "name")
    .populate("player", "playerId")
    .sort({ [query.sortBy]: sortValue })
    .limit(EXPORT_MAX_ROWS)
    .lean();

  return generateExcelBuffer(rows, [
    { header: "UTR", key: "utr" },
    {
      header: "Settlement",
      transform: (r) => (String((r as { settlementAccountType?: string }).settlementAccountType ?? "bank") === "person" ? "Liability person" : "Bank"),
    },
    {
      header: "Liability person",
      transform: (r) => String((r as { liabilityPersonName?: string }).liabilityPersonName ?? "").trim(),
    },
    { header: "Bank label", key: "bankName" },
    { header: "Amount", transform: (r) => Math.round(Number(r.amount ?? 0)) },
    { header: "Status", key: "status" },
    { header: "Bonus amount", transform: (r) => Math.round(Number(r.bonusAmount ?? 0)) },
    { header: "Total amount", transform: (r) => Math.round(Number(r.totalAmount ?? 0)) },
    { header: "Amendment count", key: "amendmentCount" },
    {
      header: "Last amended at",
      transform: (r) => formatDateTimeForTimeZone(r.lastAmendedAt, timeZone),
    },
    { header: "Reject reason", key: "rejectReason" },
    { header: "Bank balance after", transform: (r) => Math.round(Number(r.bankBalanceAfter ?? 0)) },
    { header: "Settled at", transform: (r) => formatDateTimeForTimeZone(r.settledAt, timeZone) },
    {
      header: "Transaction at",
      transform: (r) => formatDateTimeForTimeZone(r.entryAt ?? r.createdAt, timeZone),
    },
  ], "Deposits");
}

async function recomputeExchangesForDepositPlayers(doc: {
  player?: Types.ObjectId;
  amendmentHistory?: Array<{
    old?: { playerId?: string };
    new?: { playerId?: string };
  }>;
}) {
  const playerIds = new Set<string>();
  if (doc.player && Types.ObjectId.isValid(String(doc.player))) {
    playerIds.add(String(doc.player));
  }
  for (const entry of doc.amendmentHistory ?? []) {
    const oldPlayerId = entry.old?.playerId;
    const newPlayerId = entry.new?.playerId;
    if (oldPlayerId && Types.ObjectId.isValid(oldPlayerId)) playerIds.add(oldPlayerId);
    if (newPlayerId && Types.ObjectId.isValid(newPlayerId)) playerIds.add(newPlayerId);
  }
  if (playerIds.size === 0) return;

  const rows = await PlayerModel.find({ _id: { $in: [...playerIds].map((id) => new Types.ObjectId(id)) } })
    .select("exchange")
    .lean();
  const exchangeIds = new Set<string>();
  for (const row of rows) {
    if (row.exchange) {
      exchangeIds.add(String(row.exchange));
    }
  }
  for (const exchangeId of exchangeIds) {
    await enqueueExchangeRecompute(exchangeId);
    await invalidateCacheDomains(["deposit", "exchange", "referral", "player"]);
  }
}

export async function deleteDepositWithReversal(id: string, actorId: string, requestId?: string) {
  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  await ensureDepositReferralAccrualMutable(doc._id);

  if (doc.liabilityEntryId) {
    await deleteLiabilityEntryForReversal(String(doc.liabilityEntryId), actorId, requestId);
  }

  const oldValue = {
    bankId: doc.bankId?.toString(),
    bankName: doc.bankName,
    utr: doc.utr,
    amount: doc.amount,
    status: doc.status,
    playerId: doc.player?.toString(),
    bonusAmount: doc.bonusAmount,
    totalAmount: doc.totalAmount,
    entryAt: doc.entryAt,
    settledAt: doc.settledAt,
    amendmentCount: doc.amendmentCount,
    amendmentHistory: doc.amendmentHistory ?? [],
    createdAt: doc.createdAt,
  };

  const shouldReverseBank =
    (doc.status === "verified" || doc.status === "finalized") &&
    doc.bankImpact !== false &&
    !!doc.bankId &&
    Number.isFinite(Number(doc.amount));

  let bankReversalMeta: { bankId?: string; previousBalance?: number; nextBalance?: number; delta?: number } = {};
  let rollbackBank: (() => Promise<void>) | null = null;

  if (shouldReverseBank) {
    const bank = await BankModel.findById(doc.bankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    const prev = bank.currentBalance ?? bank.openingBalance;
    const delta = Number(doc.amount ?? 0);
    const next = prev - delta;
    bank.currentBalance = next;
    await bank.save();
    bankReversalMeta = {
      bankId: String(bank._id),
      previousBalance: prev,
      nextBalance: next,
      delta: -delta,
    };
    rollbackBank = async () => {
      bank.currentBalance = prev;
      await bank.save();
    };
  }

  try {
    await DepositModel.deleteOne({ _id: doc._id });
  } catch (error) {
    if (rollbackBank) await rollbackBank();
    throw error;
  }

  await recomputeExchangesForDepositPlayers({
    player: doc.player,
    amendmentHistory: doc.amendmentHistory as Array<{ old?: { playerId?: string }; new?: { playerId?: string } }>,
  });
  await cancelReferralAccrualForDeposit(doc._id, "Source deposit deleted");

  await createAuditLog({
    actorId,
    action: "deposit.delete",
    entity: "deposit",
    entityId: String(doc._id),
    oldValue: oldValue as unknown as Record<string, unknown>,
    newValue: {
      deleted: true,
      reversal: {
        status: doc.status,
        bank: bankReversalMeta,
      },
    },
    requestId,
  });

  return { id: String(doc._id), deleted: true };
}

function bonusAmountFromPercent(amount: number, percent: number, platformCurrency: string): number {
  return roundMoneyToCurrency((amount * percent) / 100, platformCurrency);
}

async function isFirstDepositForPlayer(playerId: Types.ObjectId, currentDepositId: Types.ObjectId): Promise<boolean> {
  const prior = await DepositModel.exists({
    _id: { $ne: currentDepositId },
    player: playerId,
    status: { $ne: "rejected" },
  });
  return prior == null;
}

export type ExchangeApproveOptions = {
  deferSideEffects?: boolean;
  bulkContext?: {
    exchangeIds: Set<string>;
    personSettlementSeen: boolean;
  };
};

export type BulkExchangeApproveResult = {
  approved: number;
  failed: Array<{ depositId: string; error: string }>;
};

export type BulkExchangeApproveProgress = {
  totalRows: number;
  processedRows: number;
  successRows: number;
  failedRows: number;
};

export async function exchangeApproveDeposit(
  id: string,
  input: { playerId: string; bonusAmount: number },
  actorId: string,
  requestId?: string,
  options?: ExchangeApproveOptions,
) {
  const startedAtMs = Date.now();
  const requestedBonus = Number(input.bonusAmount);
  if (!Number.isFinite(requestedBonus) || requestedBonus < 0) {
    throw new AppError("validation_error", "Invalid bonus amount", 400);
  }

  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  const platformCurrency = await requirePlatformCurrency();
  const requestedBonusRounded = roundMoneyToCurrency(requestedBonus, platformCurrency);
  if (doc.status === "verified") {
    const samePlayer = doc.player && String(doc.player) === input.playerId;
    const sameBonus = Number(doc.bonusAmount ?? 0) === requestedBonusRounded;
    if (samePlayer && sameBonus) {
      // Idempotent success: approval already applied with same effective input.
      return doc;
    }
    throw new AppError("business_rule_error", "Deposit already verified with different settlement details", 409);
  }
  if (doc.status !== "pending" && doc.status !== "not_settled") {
    throw new AppError("business_rule_error", "Deposit is not pending/not-settled exchange action", 400);
  }

  const isPersonSettlement = doc.settlementAccountType === "person";
  if (!isPersonSettlement && !doc.bankId) {
    throw new AppError("business_rule_error", "Deposit has no bank linked", 400);
  }
  if (isPersonSettlement && !doc.liabilityPersonId) {
    throw new AppError("business_rule_error", "Deposit has no liability person linked", 400);
  }

  const playerDoc = await PlayerModel.findById(input.playerId).select(
    "regularBonusPercentage firstDepositBonusPercentage exchange",
  );
  if (!playerDoc) throw new AppError("not_found", "Player not found", 404);
  if (!playerDoc.exchange) {
    throw new AppError("business_rule_error", "Player has no exchange assigned", 400);
  }

  const playerObjectId = new Types.ObjectId(input.playerId);
  const isFirstDeposit = await isFirstDepositForPlayer(playerObjectId, doc._id);
  const appliedBonusPercent = isFirstDeposit
    ? playerDoc.firstDepositBonusPercentage
    : playerDoc.regularBonusPercentage;
  const bonusFromRule = bonusAmountFromPercent(doc.amount, appliedBonusPercent, platformCurrency);
  const bonus = requestedBonusRounded;
  const totalAmount = roundMoneyToCurrency(Number(doc.amount) + bonus, platformCurrency);
  const bankCashCredit = doc.amount;

  const previousStatus = doc.status;
  const previousPlayer = doc.player;
  const previousBonus = doc.bonusAmount;
  const previousTotal = doc.totalAmount;
  const previousExchangeBy = doc.exchangeActionBy;
  const previousExchangeAt = doc.exchangeActionAt;
  const previousSettledAt = doc.settledAt;
  const previousBankBalAfter = doc.bankBalanceAfter;
  const previousLiabilityEntryId = doc.liabilityEntryId;

  if (!isPersonSettlement) {
    const bank = await BankModel.findById(doc.bankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);

    const prev = bank.currentBalance ?? bank.openingBalance;
    const bankBalanceAfter = prev + bankCashCredit;

    bank.currentBalance = bankBalanceAfter;
    await bank.save();

    try {
      doc.status = "verified" as DepositStatus;
      doc.player = playerObjectId;
      doc.bonusAmount = bonus;
      doc.totalAmount = totalAmount;
      doc.exchangeActionBy = new Types.ObjectId(actorId);
      doc.exchangeActionAt = new Date();
      doc.bankBalanceAfter = bankBalanceAfter;
      doc.settledAt = new Date();
      await doc.save();
    } catch (err) {
      bank.currentBalance = prev;
      await bank.save();
      throw err;
    }
  } else {
    doc.status = "verified" as DepositStatus;
    doc.player = playerObjectId;
    doc.bonusAmount = bonus;
    doc.totalAmount = totalAmount;
    doc.exchangeActionBy = new Types.ObjectId(actorId);
    doc.exchangeActionAt = new Date();
    doc.bankBalanceAfter = undefined;
    doc.bankImpact = false;
    doc.settledAt = new Date();
    await doc.save();

    try {
      const entryAt = doc.entryAt ?? doc.createdAt ?? new Date();
      const liabilityEntryYmd = formatDateForTimeZone(entryAt, DEFAULT_TIMEZONE) || entryAt.toISOString().slice(0, 10);
      const referenceNo = `DEP-${String(doc._id).slice(-8).toUpperCase()}`;
      const liabilityEntry = await createLiabilityEntry(
        {
          entryDate: liabilityEntryYmd,
          entryType: "journal",
          amount: doc.amount,
          fromAccountType: "person",
          fromAccountId: String(doc.liabilityPersonId),
          toAccountType: "deposit",
          toAccountId: String(doc._id),
          sourceType: "deposit",
          sourceDepositId: String(doc._id),
          referenceNo,
          remark: `Deposit settlement UTR ${String(doc.utr ?? "").trim()}`,
        },
        actorId,
        requestId,
      );
      doc.liabilityEntryId = liabilityEntry._id;
      await doc.save();
    } catch (err) {
      doc.status = previousStatus;
      doc.player = previousPlayer;
      doc.bonusAmount = previousBonus;
      doc.totalAmount = previousTotal;
      doc.exchangeActionBy = previousExchangeBy;
      doc.exchangeActionAt = previousExchangeAt;
      doc.settledAt = previousSettledAt;
      doc.bankBalanceAfter = previousBankBalAfter;
      doc.liabilityEntryId = previousLiabilityEntryId;
      await doc.save();
      throw err;
    }
  }

  const afterCoreCommitMs = Date.now();
  logger.info(
    {
      requestId,
      depositId: doc._id.toString(),
      exchangeId: String(playerDoc.exchange),
      actorId,
      coreCommitMs: afterCoreCommitMs - startedAtMs,
    },
    "Deposit exchange approve core commit completed",
  );

  const sideEffectContext = {
    requestId,
    depositId: doc._id.toString(),
    exchangeId: String(playerDoc.exchange),
    actorId,
  };
  const runSideEffect = async (step: string, task: () => Promise<void>) => {
    const stepStartedAtMs = Date.now();
    try {
      await task();
      logger.info(
        { ...sideEffectContext, step, durationMs: Date.now() - stepStartedAtMs },
        "Deposit exchange approve side-effect completed",
      );
    } catch (err) {
      logger.error({ err, ...sideEffectContext, step }, "Deposit exchange approve side-effect failed");
    }
  };

  if (options?.bulkContext) {
    options.bulkContext.exchangeIds.add(String(playerDoc.exchange));
    if (isPersonSettlement) options.bulkContext.personSettlementSeen = true;
  }

  await runSideEffect("audit_log", async () => {
    await createAuditLog({
      actorId,
      action: "deposit.exchange_approve",
      entity: "deposit",
      entityId: doc._id.toString(),
      newValue: {
        playerId: input.playerId,
        bonusAmount: bonus,
        requestedBonusAmount: requestedBonus,
        bonusFromRule,
        appliedBonusPercent,
        appliedBonusType: isFirstDeposit ? "first_deposit" : "regular",
        totalAmount,
        bankCashCredit,
        settlementAccountType: isPersonSettlement ? "person" : "bank",
        bankBalanceAfter: isPersonSettlement ? undefined : doc.bankBalanceAfter,
        liabilityPersonId: isPersonSettlement ? doc.liabilityPersonId?.toString() : undefined,
        liabilityEntryId: isPersonSettlement ? doc.liabilityEntryId?.toString() : undefined,
      },
      requestId,
    });
  });
  if (!options?.deferSideEffects) {
    await runSideEffect("enqueue_exchange_recompute", async () => {
      await enqueueExchangeRecompute(String(playerDoc.exchange));
    });
    await runSideEffect("invalidate_cache_domains", async () => {
      await invalidateCacheDomains(
        isPersonSettlement
          ? ["deposit", "exchange", "referral", "player", "liability"]
          : ["deposit", "exchange", "referral", "player"],
      );
    });
  }
  await runSideEffect("sync_referral_accrual", async () => {
    await syncReferralAccrualForDeposit(doc._id);
  });
  logger.info(
    {
      ...sideEffectContext,
      totalDurationMs: Date.now() - startedAtMs,
    },
    "Deposit exchange approve request completed",
  );

  return doc;
}

function exchangeApproveErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  return "Approve failed";
}

export async function bulkExchangeApproveDeposits(
  depositIds: string[],
  actorId: string,
  requestId?: string,
  options?: {
    onProgress?: (progress: BulkExchangeApproveProgress) => Promise<void> | void;
  },
): Promise<BulkExchangeApproveResult> {
  const uniqueIds = Array.from(new Set(depositIds.filter((id) => Types.ObjectId.isValid(id))));
  if (uniqueIds.length === 0) {
    throw new AppError("validation_error", "At least one valid deposit id is required", 400);
  }

  const bulkContext = {
    exchangeIds: new Set<string>(),
    personSettlementSeen: false,
  };
  const failed: BulkExchangeApproveResult["failed"] = [];
  let approved = 0;
  let processedRows = 0;

  for (const depositId of uniqueIds) {
    try {
      const doc = await DepositModel.findById(depositId).select("status player bonusAmount").lean();
      if (!doc) {
        failed.push({ depositId, error: "Deposit not found" });
        continue;
      }
      if (doc.status !== "pending") {
        failed.push({ depositId, error: "Only pending deposits with import player/bonus can be bulk approved" });
        continue;
      }
      if (!doc.player) {
        failed.push({ depositId, error: "Deposit has no player linked" });
        continue;
      }
      if (doc.bonusAmount == null || !Number.isFinite(Number(doc.bonusAmount))) {
        failed.push({ depositId, error: "Deposit has no bonus amount" });
        continue;
      }

      await exchangeApproveDeposit(
        depositId,
        { playerId: String(doc.player), bonusAmount: Number(doc.bonusAmount) },
        actorId,
        requestId,
        { deferSideEffects: true, bulkContext },
      );
      approved += 1;
    } catch (err) {
      failed.push({ depositId, error: exchangeApproveErrorMessage(err) });
    } finally {
      processedRows += 1;
      if (options?.onProgress) {
        await options.onProgress({
          totalRows: uniqueIds.length,
          processedRows,
          successRows: approved,
          failedRows: failed.length,
        });
      }
    }
  }

  if (approved > 0) {
    emitApprovalQueueEvent("deposit", "exchange");
    for (const exchangeId of bulkContext.exchangeIds) {
      try {
        await enqueueExchangeRecompute(exchangeId);
      } catch (err) {
        logger.error({ err, exchangeId, requestId }, "Bulk exchange approve recompute failed");
      }
    }
    try {
      await invalidateCacheDomains(
        bulkContext.personSettlementSeen
          ? ["deposit", "exchange", "referral", "player", "liability"]
          : ["deposit", "exchange", "referral", "player"],
      );
    } catch (err) {
      logger.error({ err, requestId }, "Bulk exchange approve cache invalidation failed");
    }

    setImmediate(() => {
      void createAuditLog({
        actorId,
        action: "deposit.bulk_exchange_approve",
        entity: "deposit",
        entityId: "bulk",
        newValue: {
          requestedCount: uniqueIds.length,
          approved,
          failedCount: failed.length,
          failedSample: failed.slice(0, 20),
        },
        requestId,
      }).catch((err) => {
        logger.error({ err, requestId }, "Bulk exchange approve summary audit failed");
      });
    });
  }

  return { approved, failed };
}

export async function exchangeMarkNotSettled(id: string, actorId: string, requestId?: string) {
  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  if (doc.status !== "pending") {
    throw new AppError("business_rule_error", "Only pending deposits can be marked not settled", 400);
  }

  doc.status = "not_settled";
  doc.exchangeActionBy = new Types.ObjectId(actorId);
  doc.exchangeActionAt = new Date();
  doc.player = undefined;
  doc.bonusAmount = undefined;
  doc.totalAmount = undefined;
  doc.bankBalanceAfter = undefined;
  doc.settledAt = undefined;
  doc.rejectReason = undefined;
  doc.rejectReasonId = undefined;
  await doc.save();

  await createAuditLog({
    actorId,
    action: "deposit.exchange_mark_not_settled",
    entity: "deposit",
    entityId: doc._id.toString(),
    newValue: {
      status: "not_settled",
    },
    requestId,
  });

  emitApprovalQueueEvent("deposit", "exchange");
  return doc;
}

export async function exchangeRejectDeposit(
  id: string,
  input: { reasonId: string; remark?: string },
  actorId: string,
  requestId?: string,
) {
  const resolved = await loadActiveReasonForReject(input.reasonId, REASON_TYPES.DEPOSIT_EXCHANGE_REJECT);
  const rejectText = composeRejectReasonText(resolved.masterText, input.remark);

  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  if (doc.status !== "pending" && doc.status !== "not_settled") {
    throw new AppError("business_rule_error", "Deposit is not pending/not-settled exchange action", 400);
  }

  doc.status = "rejected";
  doc.rejectReason = rejectText;
  doc.rejectReasonId = new Types.ObjectId(resolved.id);
  doc.exchangeActionBy = new Types.ObjectId(actorId);
  doc.exchangeActionAt = new Date();
  await doc.save();
  await cancelReferralAccrualForDeposit(doc._id, "Source deposit rejected");

  await createAuditLog({
    actorId,
    action: "deposit.exchange_reject",
    entity: "deposit",
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

function entryAtMsEqual(a: Date | undefined, b: Date | undefined): boolean {
  const ta = a ? a.getTime() : NaN;
  const tb = b ? b.getTime() : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return true;
  return ta === tb;
}

/**
 * Person-settled verified amendment: no bank balance; optionally refresh liability ledger when
 * cash leg (amount / entry / UTR) changes.
 */
type HydratedDepositDoc = HydratedDocument<DepositDocument>;

async function amendVerifiedDepositPersonSettlement(
  doc: HydratedDepositDoc,
  input: AmendDepositInput,
  actorId: string,
  requestId?: string,
  options?: DepositServiceOptions,
) {
  if (!doc.liabilityPersonId) {
    throw new AppError("business_rule_error", "Deposit has no liability person linked", 400);
  }
  if (!doc.player) {
    throw new AppError("business_rule_error", "Deposit is missing player", 400);
  }

  const utrTrim = normalizeUtr(input.utr);

  const newPlayerDoc = await PlayerModel.findById(input.playerId).select("exchange");
  if (!newPlayerDoc) throw new AppError("not_found", "Player not found", 404);
  if (!newPlayerDoc.exchange) {
    throw new AppError("business_rule_error", "Player has no exchange assigned", 400);
  }

  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: 0 },
  );
  const bonusPlatform = convertSecondaryAmount(
    Number(input.bonusAmount ?? 0),
    money.exchangeRate,
    money.platformCurrency,
    money.operatedCurrency,
  );
  const totalAmount = roundMoneyToCurrency(money.amount + bonusPlatform, money.platformCurrency);
  const nextEntryAt = input.entryAt ? parseBusinessDateTime(input.entryAt, "entryAt") : doc.entryAt;
  const resolved = await loadActiveReasonForReject(input.reasonId, REASON_TYPES.DEPOSIT_FINAL_AMEND);
  const amendReasonText = composeRejectReasonText(resolved.masterText, input.remark);

  const lpIdStr = doc.liabilityPersonId.toString();
  const timeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  await assertDepositTransactionNotDuplicate({
    playerId: input.playerId,
    settlementType: "person",
    settlementAccountId: lpIdStr,
    amount: money.amount,
    transactionAt: nextEntryAt ?? doc.entryAt ?? doc.createdAt,
    utr: utrTrim,
    timeZone,
    excludeDepositId: doc._id,
  });
  const lpName = String(doc.liabilityPersonName ?? "").trim();

  const needsLiabilityRefresh =
    Number(money.amount) !== Number(doc.amount) ||
    utrTrim !== normalizeUtr(doc.utr) ||
    !entryAtMsEqual(nextEntryAt, doc.entryAt);

  const oldSnapshot: DepositAmendmentSnapshot = {
    bankId: doc.bankId?.toString(),
    bankName: doc.bankName,
    liabilityPersonId: lpIdStr,
    liabilityPersonName: lpName || undefined,
    utr: doc.utr,
    amount: doc.amount,
    playerId: doc.player?.toString(),
    bonusAmount: doc.bonusAmount,
    totalAmount: doc.totalAmount,
  };

  const newSnapshotPlain: DepositAmendmentSnapshot = {
    liabilityPersonId: lpIdStr,
    liabilityPersonName: lpName || undefined,
    utr: utrTrim,
    amount: money.amount,
    playerId: input.playerId,
    bonusAmount: bonusPlatform,
    totalAmount,
  };

  const prevUtr = doc.utr;
  const prevAmount = doc.amount;
  const prevEntryAt = doc.entryAt ? new Date(doc.entryAt.getTime()) : undefined;
  const prevBonus = doc.bonusAmount;
  const prevTotal = doc.totalAmount;
  const prevPlayer = doc.player;
  const prevLiabilityEntryId = doc.liabilityEntryId;
  const prevAmendCount = doc.amendmentCount ?? 0;
  const prevHistory = [...(doc.amendmentHistory ?? [])];
  const prevLastAmendedAt = doc.lastAmendedAt;
  const prevLastAmendedBy = doc.lastAmendedBy;

  const oldPlayerId = doc.player;

  if (needsLiabilityRefresh && doc.liabilityEntryId) {
    await deleteLiabilityEntryForReversal(String(doc.liabilityEntryId), actorId, requestId);
    doc.liabilityEntryId = undefined;
  }

  doc.utr = utrTrim;
  doc.amount = money.amount;
  doc.operatedCurrency = money.operatedCurrency;
  doc.operatedAmount = money.operatedAmount;
  doc.exchangeRate = money.exchangeRate;
  doc.player = new Types.ObjectId(input.playerId);
  doc.bonusAmount = bonusPlatform;
  doc.totalAmount = totalAmount;
  doc.entryAt = nextEntryAt;
  doc.duplicateKey = buildDepositDuplicateKey({
    playerId: input.playerId,
    settlementType: "person",
    settlementAccountId: lpIdStr,
    amount: money.amount,
    transactionAt: nextEntryAt ?? doc.entryAt ?? doc.createdAt,
    utr: utrTrim,
    timeZone,
  });
  doc.bankBalanceAfter = undefined;
  doc.bankImpact = false;
  doc.amendmentCount = prevAmendCount + 1;
  doc.lastAmendedAt = new Date();
  doc.lastAmendedBy = new Types.ObjectId(actorId);
  const history = doc.amendmentHistory ?? [];
  history.push({
    at: new Date(),
    by: new Types.ObjectId(actorId),
    reason: amendReasonText,
    old: oldSnapshot,
    new: newSnapshotPlain,
  });
  doc.amendmentHistory = history;

  await doc.save();

  if (needsLiabilityRefresh) {
    try {
      const entryAt = doc.entryAt ?? doc.createdAt ?? new Date();
      const liabilityEntryYmd =
        formatDateForTimeZone(entryAt, DEFAULT_TIMEZONE) || entryAt.toISOString().slice(0, 10);
      const referenceNo = `DEP-${String(doc._id).slice(-8).toUpperCase()}`;
      const liabilityEntry = await createLiabilityEntry(
        {
          entryDate: liabilityEntryYmd,
          entryType: "journal",
          amount: doc.amount,
          fromAccountType: "person",
          fromAccountId: String(doc.liabilityPersonId),
          toAccountType: "deposit",
          toAccountId: String(doc._id),
          sourceType: "deposit",
          sourceDepositId: String(doc._id),
          referenceNo,
          remark: `Deposit settlement UTR ${String(doc.utr ?? "").trim()}`,
        },
        actorId,
        requestId,
      );
      doc.liabilityEntryId = liabilityEntry._id;
      await doc.save();
    } catch (err) {
      doc.utr = prevUtr;
      doc.amount = prevAmount;
      doc.entryAt = prevEntryAt;
      doc.player = prevPlayer;
      doc.bonusAmount = prevBonus;
      doc.totalAmount = prevTotal;
      doc.amendmentCount = prevAmendCount;
      doc.amendmentHistory = prevHistory;
      doc.liabilityEntryId = prevLiabilityEntryId;

      doc.lastAmendedAt = prevLastAmendedAt;
      doc.lastAmendedBy = prevLastAmendedBy;
      await doc.save();

      if (needsLiabilityRefresh && prevLiabilityEntryId) {
        const entryAtRb = prevEntryAt ?? doc.createdAt ?? new Date();
        const liabilityEntryYmd =
          formatDateForTimeZone(entryAtRb, DEFAULT_TIMEZONE) || entryAtRb.toISOString().slice(0, 10);
        const referenceNoRb = `DEP-${String(doc._id).slice(-8).toUpperCase()}-RB`;
        const restored = await createLiabilityEntry(
          {
            entryDate: liabilityEntryYmd,
            entryType: "journal",
            amount: prevAmount,
            fromAccountType: "person",
            fromAccountId: String(doc.liabilityPersonId),
            toAccountType: "deposit",
            toAccountId: String(doc._id),
            sourceType: "deposit",
            sourceDepositId: String(doc._id),
            referenceNo: referenceNoRb,
            remark: `Deposit settlement UTR ${String(prevUtr ?? "").trim()} (rollback)`,
          },
          actorId,
          requestId,
        );
        doc.liabilityEntryId = restored._id;
        await doc.save();
      }
      throw err;
    }
  }

  const oldPlayer = await PlayerModel.findById(oldPlayerId).select("exchange");
  const exchanges = new Set<string>();
  if (oldPlayer?.exchange) exchanges.add(String(oldPlayer.exchange));
  if (newPlayerDoc.exchange) exchanges.add(String(newPlayerDoc.exchange));
  for (const ex of exchanges) {
    await enqueueExchangeRecompute(ex);
  }
  await invalidateCacheDomains(["deposit", "exchange", "referral", "player", "liability"]);
  await syncReferralAccrualForDeposit(doc._id);

  await createAuditLog({
    actorId,
    action: "deposit.amend",
    entity: "deposit",
    entityId: doc._id.toString(),
    oldValue: { ...oldSnapshot, entryAt: prevEntryAt, settlementAccountType: "person" } as unknown as Record<
      string,
      unknown
    >,
    newValue: {
      ...newSnapshotPlain,
      entryAt: nextEntryAt,
      reason: amendReasonText,
      reasonId: resolved.id,
      remark: input.remark?.trim() || undefined,
      settlementAccountType: "person",
    } as unknown as Record<string, unknown>,
    requestId,
  });

  return doc;
}

/**
 * In-place amendment for settled (`verified`) deposits. Updates bank cash balance delta,
 * exchange recomputation for affected players, and appends `amendmentHistory`.
 */
export async function amendVerifiedDeposit(
  id: string,
  input: AmendDepositInput,
  actorId: string,
  requestId?: string,
  options?: DepositServiceOptions,
) {
  const doc = await DepositModel.findById(id);
  if (!doc) throw new AppError("not_found", "Deposit not found", 404);
  await ensureDepositReferralAccrualMutable(doc._id);
  if (doc.status !== "verified") {
    throw new AppError("business_rule_error", "Only verified deposits can be amended", 400);
  }

  const isPersonSettlement = doc.settlementAccountType === "person";

  if (isPersonSettlement) {
    return amendVerifiedDepositPersonSettlement(doc as HydratedDepositDoc, input, actorId, requestId, options);
  }

  if (!input.bankId) {
    throw new AppError("validation_error", "Bank is required for bank-settled deposit amendments.", 400);
  }
  if (!doc.bankId) {
    throw new AppError("business_rule_error", "Deposit has no bank linked", 400);
  }
  if (!doc.player) {
    throw new AppError("business_rule_error", "Deposit is missing bank or player", 400);
  }

  const utrTrim = normalizeUtr(input.utr);

  const newBankDoc = await BankModel.findById(input.bankId);
  if (!newBankDoc) throw new AppError("not_found", "Bank not found", 404);
  if (newBankDoc.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);

  const newPlayerDoc = await PlayerModel.findById(input.playerId).select("exchange");
  if (!newPlayerDoc) throw new AppError("not_found", "Player not found", 404);
  if (!newPlayerDoc.exchange) {
    throw new AppError("business_rule_error", "Player has no exchange assigned", 400);
  }

  const money = await resolveMoneyFromRequest(
    {
      amount: input.amount,
      operatedCurrency: input.operatedCurrency,
      operatedAmount: input.operatedAmount,
      exchangeRate: input.exchangeRate,
    },
    { minPlatformAmount: 0 },
  );
  const bonusPlatform = convertSecondaryAmount(
    Number(input.bonusAmount ?? 0),
    money.exchangeRate,
    money.platformCurrency,
    money.operatedCurrency,
  );
  const totalAmount = roundMoneyToCurrency(money.amount + bonusPlatform, money.platformCurrency);
  const nextEntryAt = input.entryAt ? parseBusinessDateTime(input.entryAt, "entryAt") : doc.entryAt;
  const resolved = await loadActiveReasonForReject(input.reasonId, REASON_TYPES.DEPOSIT_FINAL_AMEND);
  const amendReasonText = composeRejectReasonText(resolved.masterText, input.remark);
  const timeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  await assertDepositTransactionNotDuplicate({
    playerId: input.playerId,
    settlementType: "bank",
    settlementAccountId: input.bankId,
    amount: money.amount,
    transactionAt: nextEntryAt ?? doc.entryAt ?? doc.createdAt,
    utr: utrTrim,
    timeZone,
    excludeDepositId: doc._id,
  });

  const oldBankId = doc.bankId;
  const oldAmount = doc.amount;
  const newBankId = new Types.ObjectId(input.bankId);
  const newAmount = money.amount;

  const oldSnapshot: DepositAmendmentSnapshot = {
    bankId: doc.bankId?.toString(),
    bankName: doc.bankName,
    utr: doc.utr,
    amount: doc.amount,
    playerId: doc.player?.toString(),
    bonusAmount: doc.bonusAmount,
    totalAmount: doc.totalAmount,
  };
  const oldEntryAt = doc.entryAt;

  const newSnapshotPlain: DepositAmendmentSnapshot = {
    bankId: input.bankId,
    bankName: bankDisplayName(newBankDoc),
    utr: utrTrim,
    amount: money.amount,
    playerId: input.playerId,
    bonusAmount: bonusPlatform,
    totalAmount,
  };

  let newBankBalanceAfter: number;
  let rollbackBanks: (() => Promise<void>) | undefined;

  if (String(oldBankId) === String(newBankId)) {
    const bank = await BankModel.findById(oldBankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    const prevBal = bank.currentBalance ?? bank.openingBalance;
    const delta = newAmount - oldAmount;
    const nextBal = prevBal + delta;
    bank.currentBalance = nextBal;
    await bank.save();
    newBankBalanceAfter = nextBal;
    rollbackBanks = async () => {
      bank.currentBalance = prevBal;
      await bank.save();
    };
  } else {
    const oldBank = await BankModel.findById(oldBankId);
    if (!oldBank) throw new AppError("not_found", "Bank not found", 404);
    const prevOld = oldBank.currentBalance ?? oldBank.openingBalance;
    oldBank.currentBalance = prevOld - oldAmount;
    await oldBank.save();

    const creditBank = await BankModel.findById(newBankId);
    if (!creditBank) {
      oldBank.currentBalance = prevOld;
      await oldBank.save();
      throw new AppError("not_found", "Bank not found", 404);
    }
    const prevNew = creditBank.currentBalance ?? creditBank.openingBalance;
    creditBank.currentBalance = prevNew + newAmount;
    try {
      await creditBank.save();
    } catch (err) {
      oldBank.currentBalance = prevOld;
      await oldBank.save();
      throw err;
    }
    newBankBalanceAfter = creditBank.currentBalance ?? creditBank.openingBalance;

    rollbackBanks = async () => {
      oldBank.currentBalance = prevOld;
      await oldBank.save();
      creditBank.currentBalance = prevNew;
      await creditBank.save();
    };
  }

  const oldPlayerId = doc.player;

  try {
    doc.bankId = newBankId;
    doc.bankName = newSnapshotPlain.bankName ?? doc.bankName;
    doc.utr = utrTrim;
    doc.amount = money.amount;
    doc.operatedCurrency = money.operatedCurrency;
    doc.operatedAmount = money.operatedAmount;
    doc.exchangeRate = money.exchangeRate;
    doc.player = new Types.ObjectId(input.playerId);
    doc.bonusAmount = bonusPlatform;
    doc.totalAmount = totalAmount;
    doc.entryAt = nextEntryAt;
    doc.duplicateKey = buildDepositDuplicateKey({
      playerId: input.playerId,
      settlementType: "bank",
      settlementAccountId: input.bankId,
      amount: money.amount,
      transactionAt: nextEntryAt ?? doc.entryAt ?? doc.createdAt,
      utr: utrTrim,
      timeZone,
    });
    doc.bankBalanceAfter = newBankBalanceAfter;
    doc.amendmentCount = (doc.amendmentCount ?? 0) + 1;
    doc.lastAmendedAt = new Date();
    doc.lastAmendedBy = new Types.ObjectId(actorId);
    const history = doc.amendmentHistory ?? [];
    history.push({
      at: new Date(),
      by: new Types.ObjectId(actorId),
      reason: amendReasonText,
      old: oldSnapshot,
      new: newSnapshotPlain,
    });
    doc.amendmentHistory = history;
    await doc.save();
  } catch (err) {
    if (rollbackBanks) await rollbackBanks();
    throw err;
  }

  const oldPlayer = await PlayerModel.findById(oldPlayerId).select("exchange");
  const exchanges = new Set<string>();
  if (oldPlayer?.exchange) exchanges.add(String(oldPlayer.exchange));
  if (newPlayerDoc.exchange) exchanges.add(String(newPlayerDoc.exchange));
  for (const ex of exchanges) {
    await enqueueExchangeRecompute(ex);
  }
  await invalidateCacheDomains(["deposit", "exchange", "referral", "player"]);
  await syncReferralAccrualForDeposit(doc._id);

  await createAuditLog({
    actorId,
    action: "deposit.amend",
    entity: "deposit",
    entityId: doc._id.toString(),
    oldValue: { ...oldSnapshot, entryAt: oldEntryAt } as unknown as Record<string, unknown>,
    newValue: {
      ...newSnapshotPlain,
      entryAt: nextEntryAt,
      reason: amendReasonText,
      reasonId: resolved.id,
      remark: input.remark?.trim() || undefined,
    } as unknown as Record<string, unknown>,
    requestId,
  });

  return doc;
}

// ---------------------------------------------------------------------------
// CSV/Excel Import
// ---------------------------------------------------------------------------

/** CSV column headers — match Deposit / Exchange form labels. */
export const DEPOSIT_IMPORT_CSV_COLUMNS = {
  entryDateTime: "Entry date & time",
  settlement: "Settlement",
  bank: "Bank",
  liabilityPerson: "Liability person",
  referenceNumber: "Reference Number",
  operatedCurrency: "Operated currency",
  amount: "Amount",
  traderWalletId: "Trader Wallet Id",
} as const;

export const DEPOSIT_IMPORT_CSV_HEADER_LIST = [
  DEPOSIT_IMPORT_CSV_COLUMNS.entryDateTime,
  DEPOSIT_IMPORT_CSV_COLUMNS.settlement,
  DEPOSIT_IMPORT_CSV_COLUMNS.bank,
  DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson,
  DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber,
  DEPOSIT_IMPORT_CSV_COLUMNS.operatedCurrency,
  DEPOSIT_IMPORT_CSV_COLUMNS.amount,
  DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId,
] as const;

export type DepositImportValidRow = {
  row: number;
  utr: string;
  amount: number;
  operatedCurrency: string;
  operatedAmount: number;
  exchangeRate: number;
  entryAt?: string;
  settlementAccountType: "bank" | "person";
  bankId?: string;
  bankAccountNumber?: string;
  bankDisplayLabel?: string;
  liabilityPersonId?: string;
  liabilityPersonName?: string;
  playerMongoId?: string;
  playerIdLabel?: string;
  bonusAmount?: number;
  totalAmount?: number;
};

export type DepositImportInvalidRow = {
  row: number;
  dateTime: string;
  settlementType: string;
  bankAccountNumber: string;
  liablePersonName: string;
  operatedCurrency: string;
  amount: string;
  exchangeRate: string;
  platformAmount: string;
  playerId: string;
  utr: string;
  errors: string[];
};

export type DepositImportValidationResult = {
  summary: { total: number; valid: number; invalid: number; skipped: number };
  validRows: DepositImportValidRow[];
  invalidRows: DepositImportInvalidRow[];
};

function parseDepositImportSettlementMode(raw: string): "bank" | "person" {
  const value = raw.trim().toLowerCase();
  if (value === "person" || value === "liability person" || value === "liabilityperson") {
    return "person";
  }
  return "bank";
}

function makeDepositImportInvalidRow(fields: {
  row: number;
  dateTime?: string;
  settlementType?: string;
  bankAccountNumber?: string;
  liablePersonName?: string;
  operatedCurrency?: string;
  amount?: string;
  exchangeRate?: string;
  platformAmount?: string;
  playerId?: string;
  utr?: string;
  errors: string[];
}): DepositImportInvalidRow {
  return {
    row: fields.row,
    dateTime: fields.dateTime ?? "",
    settlementType: fields.settlementType ?? "Bank",
    bankAccountNumber: fields.bankAccountNumber ?? "",
    liablePersonName: fields.liablePersonName ?? "",
    operatedCurrency: fields.operatedCurrency ?? "",
    amount: fields.amount ?? "",
    exchangeRate: fields.exchangeRate ?? "",
    platformAmount: fields.platformAmount ?? "",
    playerId: fields.playerId ?? "",
    utr: fields.utr ?? "",
    errors: fields.errors,
  };
}

async function resolveDepositImportRowMoney(
  operatedCurrencyRaw: string,
  amountRaw: string,
  platformCurrency: SupportedCurrency,
  rateCache: Map<string, number | null>,
): Promise<
  | {
      ok: true;
      operatedCurrency: SupportedCurrency;
      operatedAmount: number;
      exchangeRate: number;
      amount: number;
    }
  | { ok: false; errors: string[] }
> {
  const errors: string[] = [];
  if (!amountRaw.trim()) {
    errors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.amount} is required`);
    return { ok: false, errors };
  }

  const rawAmount = Number(amountRaw);
  if (Number.isNaN(rawAmount)) {
    errors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.amount} must be a valid number`);
    return { ok: false, errors };
  }

  const operatedCurrency = (operatedCurrencyRaw.trim().toUpperCase() || platformCurrency) as string;
  if (!isSupportedCurrency(operatedCurrency)) {
    errors.push(`Unsupported currency: ${operatedCurrencyRaw.trim() || operatedCurrency}`);
    return { ok: false, errors };
  }

  const minOperated = getCurrencyMinUnit(operatedCurrency);
  if (rawAmount < minOperated) {
    errors.push(
      `${DEPOSIT_IMPORT_CSV_COLUMNS.amount} must be at least ${minOperated} in ${operatedCurrency}`,
    );
    return { ok: false, errors };
  }

  let exchangeRate: number;
  if (operatedCurrency === platformCurrency) {
    exchangeRate = 1;
  } else {
    let cachedRate = rateCache.get(operatedCurrency);
    if (cachedRate === undefined) {
      const master = await resolveMasterExchangeRate(operatedCurrency, platformCurrency);
      cachedRate = master.rate;
      rateCache.set(operatedCurrency, cachedRate);
    }
    if (cachedRate == null) {
      errors.push(`No master exchange rate for ${operatedCurrency} → ${platformCurrency}`);
      return { ok: false, errors };
    }
    exchangeRate = cachedRate;
  }

  try {
    const money = resolveMoneyInput({
      operatedAmount: rawAmount,
      operatedCurrency,
      exchangeRate,
      platformCurrency,
      fieldLabel: DEPOSIT_IMPORT_CSV_COLUMNS.amount,
      minPlatformAmount: getCurrencyMinUnit(platformCurrency),
    });
    return {
      ok: true,
      operatedCurrency: money.operatedCurrency,
      operatedAmount: money.operatedAmount,
      exchangeRate: money.exchangeRate,
      amount: money.amount,
    };
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Invalid amount conversion";
    errors.push(message);
    return { ok: false, errors };
  }
}

function importNormalizeHeaderKey(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function importPickCell(row: Record<string, unknown>, ...aliases: string[]): string {
  const wanted = new Set(aliases.map((a) => importNormalizeHeaderKey(a)));
  for (const [key, val] of Object.entries(row)) {
    if (!wanted.has(importNormalizeHeaderKey(key))) continue;
    if (val != null && String(val).trim() !== "") return String(val).trim();
  }
  return "";
}

function importReadRows(buffer: Buffer, originalName: string): Record<string, unknown>[] {
  const lower = originalName.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
    throw new AppError("validation_error", "Unsupported file type. Use .csv, .xlsx, or .xls", 400);
  }
  const wb = xlsx.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new AppError("validation_error", "File is empty or has no sheets", 400);
  }
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: "", raw: false });
}

const DEPOSIT_IMPORT_INVALID_DATE_MESSAGE =
  "Invalid date/time. Use DD/MM/YYYY HH:mm (or upload as-is from Excel); seconds and AM/PM are accepted.";

export async function validateDepositImportRows(
  buffer: Buffer,
  originalName: string,
  options?: { timeZone?: string },
): Promise<DepositImportValidationResult> {
  const importTimeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  const rows = importReadRows(buffer, originalName);
  if (rows.length === 0) {
    throw new AppError("validation_error", "File contains no data rows", 400);
  }
  if (rows.length > 10000) {
    throw new AppError("validation_error", "Maximum 10000 rows allowed per import", 400);
  }

  const platformCurrency = await requirePlatformCurrency();
  const rateCache = new Map<string, number | null>();

  const validRows: DepositImportValidRow[] = [];
  const invalidRows: DepositImportInvalidRow[] = [];
  let skipped = 0;

  const allBankIdentifiers: string[] = [];
  const allPersonNames: string[] = [];
  const allPlayerIds: string[] = [];
  const rowDataList: Array<{
    rowNum: number;
    dateTimeValue: unknown;
    settlementType: string;
    bankIdentifier: string;
    personName: string;
    playerIdRaw: string;
    operatedCurrencyRaw: string;
    utr: string;
    amountRaw: string;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const utr = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber,
      "reference number",
      "referencenumber",
      "utr",
      "UTR",
      "transaction_id",
      "transaction id",
    );
    const amountRaw = importPickCell(row, DEPOSIT_IMPORT_CSV_COLUMNS.amount, "amount");
    const operatedCurrencyRaw = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.operatedCurrency,
      "operated currency",
      "operatedcurrency",
      "currency",
    );
    const dateTimeValue = importPickRaw(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.entryDateTime,
      "date time",
      "datetime",
      "date_time",
      "entry_at",
      "entryat",
      "date",
    );
    const settlementType = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.settlement,
      "settlement type",
      "settlement_type",
      "settlementtype",
      "type",
    );
    const bankIdentifier = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.bank,
      "bank account number",
      "bank_account_number",
      "bankaccountnumber",
      "account_number",
      "account number",
      "accountnumber",
      "holder name",
      "holdername",
      "holder_name",
      "bank holder",
      "bankholder",
    );
    const personName = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson,
      "liable person name",
      "liable_person_name",
      "liablepersonname",
      "person_name",
      "person name",
      "personname",
      "liability person",
      "liabilityperson",
    );
    const playerIdRaw = importPickCell(
      row,
      DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId,
      "trader wallet id",
      "trader id",
      "player id",
      "playerid",
      "player_id",
      "player",
    );
    if (
      !utr &&
      !amountRaw &&
      !bankIdentifier &&
      !personName &&
      !playerIdRaw &&
      !operatedCurrencyRaw
    ) {
      skipped++;
      continue;
    }

    rowDataList.push({
      rowNum,
      dateTimeValue,
      settlementType,
      bankIdentifier,
      personName,
      playerIdRaw,
      operatedCurrencyRaw,
      utr,
      amountRaw,
    });
    if (bankIdentifier) allBankIdentifiers.push(bankIdentifier.trim().toLowerCase());
    if (personName) allPersonNames.push(personName.toLowerCase());
    if (playerIdRaw) allPlayerIds.push(playerIdRaw.trim().toLowerCase());
  }

  const uniqueBankIdentifiers = [...new Set(allBankIdentifiers)];
  const uniquePersonNames = [...new Set(allPersonNames)];
  const uniquePlayerIds = [...new Set(allPlayerIds)];

  const bankMaps = await loadBanksForImportIdentifiers(uniqueBankIdentifiers);
  const personMap = await loadLiabilityPersonsForImportNames(uniquePersonNames);
  const exchangePlayerMap = await loadPlayersForImportPlayerIds(uniquePlayerIds);

  const bankResolutionCache = buildBankResolutionCache(uniqueBankIdentifiers, bankMaps);
  const personResolutionCache = buildPersonResolutionCache(uniquePersonNames, personMap);
  const exchangePlayerResolutionCache = buildExchangePlayerResolutionCache(uniquePlayerIds, exchangePlayerMap);

  const seenDuplicateKeys = new Set<string>();

  for (const rd of rowDataList) {
    const rowErrors: string[] = [];
    const mode = parseDepositImportSettlementMode(rd.settlementType);

    if (!rd.utr) {
      rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber} is required`);
    } else if (rd.utr.length < 4) {
      rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber} must be at least 4 characters`);
    } else if (rd.utr.length > 120) {
      rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber} must not exceed 120 characters`);
    }

    const moneyResult = await resolveDepositImportRowMoney(
      rd.operatedCurrencyRaw,
      rd.amountRaw,
      platformCurrency,
      rateCache,
    );
    if (!moneyResult.ok) {
      rowErrors.push(...moneyResult.errors);
    }

    let parsedDate: Date | null = null;
    if (isImportDateTimePresent(rd.dateTimeValue)) {
      parsedDate = parseImportDateTime(rd.dateTimeValue, importTimeZone);
      if (!parsedDate) {
        rowErrors.push(DEPOSIT_IMPORT_INVALID_DATE_MESSAGE);
      }
    }

    let resolvedBankId: string | undefined;
    let resolvedBankDisplay: string | undefined;
    let resolvedPersonId: string | undefined;
    let resolvedPersonName: string | undefined;
    let resolvedPlayerMongoId: string | undefined;
    let resolvedPlayerIdLabel: string | undefined;
    let resolvedBonusAmount: number | undefined;
    let resolvedTotalAmount: number | undefined;

    const hasPlayerIdRaw = rd.playerIdRaw.trim() !== "";

    if (!hasPlayerIdRaw) {
      rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId} is required`);
    }

    if (hasPlayerIdRaw) {
      const playerKey = rd.playerIdRaw.trim().toLowerCase();
      const playerResult = exchangePlayerResolutionCache.get(playerKey);
      if (playerResult?.status === "ambiguous") {
        rowErrors.push(
          `Multiple players found with ${DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId} "${rd.playerIdRaw}". ${DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId} must be unique across exchanges in this file.`,
        );
      } else if (!playerResult || playerResult.status === "not_found") {
        rowErrors.push(`Player "${rd.playerIdRaw}" not found`);
      } else {
        resolvedPlayerMongoId = playerResult.id;
        resolvedPlayerIdLabel = playerResult.playerIdLabel;
        resolvedBonusAmount = 0;
      }
    }

    if (mode === "bank") {
      if (!rd.bankIdentifier) {
        rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.bank} is required for Bank settlement`);
      } else {
        const key = rd.bankIdentifier.trim().toLowerCase();
        const bankResult = bankResolutionCache.get(key);
        if (bankResult?.status === "ambiguous") {
          rowErrors.push(
            `Multiple banks found with holder name "${rd.bankIdentifier}". Use account number instead.`,
          );
        } else if (!bankResult || bankResult.status === "not_found") {
          rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.bank} "${rd.bankIdentifier}" not found (tried account number and holder name)`);
        } else if (bankResult.status === "inactive") {
          rowErrors.push(`Bank "${bankResult.displayName}" is not active`);
        } else {
          resolvedBankId = bankResult.id;
          resolvedBankDisplay = bankResult.displayName;
        }
      }
    } else if (!rd.personName) {
      rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson} is required for Liability person settlement`);
    } else {
      const key = rd.personName.trim().toLowerCase();
      const personResult = personResolutionCache.get(key);
      if (!personResult || personResult.status === "not_found") {
        rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson} "${rd.personName}" not found`);
      } else if (personResult.status === "inactive") {
        rowErrors.push(`${DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson} "${personResult.name}" is inactive`);
      } else {
        resolvedPersonId = personResult.id;
        resolvedPersonName = personResult.name;
      }
    }

    const platformAmount = moneyResult.ok ? moneyResult.amount : undefined;
    if (
      resolvedPlayerMongoId != null &&
      resolvedBonusAmount != null &&
      platformAmount != null &&
      rowErrors.length === 0
    ) {
      resolvedTotalAmount = Math.round(platformAmount);
    }

    if (rowErrors.length > 0) {
      invalidRows.push(
        makeDepositImportInvalidRow({
          row: rd.rowNum,
          dateTime: formatImportDateTimeForDisplay(rd.dateTimeValue),
          settlementType: rd.settlementType || "Bank",
          bankAccountNumber: rd.bankIdentifier,
          liablePersonName: rd.personName,
          operatedCurrency: rd.operatedCurrencyRaw,
          amount: rd.amountRaw,
          exchangeRate: moneyResult.ok ? String(moneyResult.exchangeRate) : "",
          platformAmount: platformAmount != null ? String(platformAmount) : "",
          playerId: rd.playerIdRaw,
          utr: rd.utr,
          errors: rowErrors,
        }),
      );
    } else if (moneyResult.ok) {
      const settlementAccountId = mode === "bank" ? resolvedBankId! : resolvedPersonId!;
      const transactionAt = parsedDate ?? new Date();
      const dupInput = {
        playerId: resolvedPlayerMongoId!,
        settlementType: mode,
        settlementAccountId,
        amount: platformAmount!,
        transactionAt,
        utr: rd.utr,
        timeZone: importTimeZone,
      };
      const dupKey = buildTransactionDuplicateKey(dupInput);
      if (seenDuplicateKeys.has(dupKey)) {
        rowErrors.push(`Duplicate transaction within this file (${DUPLICATE_TRANSACTION_MESSAGE.toLowerCase()})`);
      } else {
        const existingDup = await findDuplicateTransaction(dupInput);
        if (existingDup) {
          rowErrors.push(DUPLICATE_TRANSACTION_MESSAGE);
        } else {
          seenDuplicateKeys.add(dupKey);
        }
      }

      if (rowErrors.length > 0) {
        invalidRows.push(
          makeDepositImportInvalidRow({
            row: rd.rowNum,
            dateTime: formatImportDateTimeForDisplay(rd.dateTimeValue),
            settlementType: rd.settlementType || "Bank",
            bankAccountNumber: rd.bankIdentifier,
            liablePersonName: rd.personName,
            operatedCurrency: rd.operatedCurrencyRaw,
            amount: rd.amountRaw,
            exchangeRate: String(moneyResult.exchangeRate),
            platformAmount: platformAmount != null ? String(platformAmount) : "",
            playerId: rd.playerIdRaw,
            utr: rd.utr,
            errors: rowErrors,
          }),
        );
      } else {
      validRows.push({
        row: rd.rowNum,
        utr: rd.utr,
        amount: moneyResult.amount,
        operatedCurrency: moneyResult.operatedCurrency,
        operatedAmount: moneyResult.operatedAmount,
        exchangeRate: moneyResult.exchangeRate,
        entryAt: parsedDate ? parsedDate.toISOString() : undefined,
        settlementAccountType: mode,
        bankId: resolvedBankId,
        bankAccountNumber: rd.bankIdentifier || undefined,
        bankDisplayLabel: resolvedBankDisplay,
        liabilityPersonId: resolvedPersonId,
        liabilityPersonName: resolvedPersonName,
        playerMongoId: resolvedPlayerMongoId,
        playerIdLabel: resolvedPlayerIdLabel,
        bonusAmount: resolvedBonusAmount,
        totalAmount: resolvedTotalAmount,
      });
      }
    }
  }

  return {
    summary: {
      total: rowDataList.length + skipped,
      valid: validRows.length,
      invalid: invalidRows.length,
      skipped,
    },
    validRows,
    invalidRows,
  };
}

export type DepositImportCommitRow = {
  utr: string;
  amount: number;
  operatedCurrency: string;
  operatedAmount: number;
  exchangeRate: number;
  entryAt?: string;
  settlementAccountType: "bank" | "person";
  bankId?: string;
  liabilityPersonId?: string;
  playerMongoId?: string;
  bonusAmount?: number;
  totalAmount?: number;
};

type DepositImportCommitError = { row: number; utr: string; error: string };

type IndexedDepositImportRow = { index: number; row: DepositImportCommitRow };

type BankImportLean = {
  _id: Types.ObjectId;
  holderName: string;
  bankName: string;
  accountNumber: string;
  status: string;
};

type PersonImportLean = {
  _id: Types.ObjectId;
  name: string;
  isActive: boolean;
};

async function loadDepositImportLookups(rows: DepositImportCommitRow[]) {
  const bankIdSet = new Set<string>();
  const personIdSet = new Set<string>();
  for (const row of rows) {
    if (row.bankId && Types.ObjectId.isValid(row.bankId)) bankIdSet.add(row.bankId);
    if (row.liabilityPersonId && Types.ObjectId.isValid(row.liabilityPersonId)) {
      personIdSet.add(row.liabilityPersonId);
    }
  }
  const [banks, persons] = await Promise.all([
    bankIdSet.size > 0
      ? BankModel.find({ _id: { $in: [...bankIdSet].map((id) => new Types.ObjectId(id)) } })
          .select("holderName bankName accountNumber status")
          .lean()
      : [],
    personIdSet.size > 0
      ? LiabilityPersonModel.find({ _id: { $in: [...personIdSet].map((id) => new Types.ObjectId(id)) } })
          .select("name isActive")
          .lean()
      : [],
  ]);
  return {
    bankById: new Map(banks.map((b) => [String(b._id), b as BankImportLean])),
    personById: new Map(persons.map((p) => [String(p._id), p as PersonImportLean])),
  };
}

function buildDepositImportInsertDoc(
  row: DepositImportCommitRow,
  actorOid: Types.ObjectId,
  bankById: Map<string, BankImportLean>,
  personById: Map<string, PersonImportLean>,
  platformCurrency: SupportedCurrency,
  importTimeZone: string,
): Record<string, unknown> | { error: string; ok?: false } {
  let money: ReturnType<typeof resolveMoneyInput>;
  try {
    money = resolveMoneyInput({
      operatedAmount: row.operatedAmount,
      operatedCurrency: row.operatedCurrency,
      exchangeRate: row.exchangeRate,
      platformCurrency,
      fieldLabel: DEPOSIT_IMPORT_CSV_COLUMNS.amount,
      minPlatformAmount: getCurrencyMinUnit(platformCurrency),
    });
  } catch (err) {
    return { error: err instanceof AppError ? err.message : "Invalid amount conversion" };
  }

  if (money.amount !== row.amount) {
    return { error: "Platform amount does not match operated amount and exchange rate" };
  }

  const mode = row.settlementAccountType ?? "bank";
  const entryAt = row.entryAt ? parseBusinessDateTime(row.entryAt, "entryAt") : new Date();
  const base: Record<string, unknown> = {
    utr: normalizeUtr(row.utr),
    amount: money.amount,
    operatedCurrency: money.operatedCurrency,
    operatedAmount: money.operatedAmount,
    exchangeRate: money.exchangeRate,
    status: "pending",
    entryAt,
    createdBy: actorOid,
    settlementAccountType: mode,
    amendmentCount: 0,
    amendmentHistory: [],
  };

  if (row.playerMongoId?.trim()) {
    if (!Types.ObjectId.isValid(row.playerMongoId)) {
      return { error: "Invalid player reference" };
    }
    base.player = new Types.ObjectId(row.playerMongoId);
    base.bonusAmount = 0;
    base.totalAmount = money.amount;
  }

  if (mode === "bank") {
    const bankIdStr = row.bankId?.trim();
    if (!bankIdStr) return { error: "Bank is required" };
    const bank = bankById.get(bankIdStr);
    if (!bank) return { error: "Bank not found" };
    if (bank.status !== "active") return { error: "Bank is not active" };
    if (row.playerMongoId?.trim()) {
      base.duplicateKey = buildTransactionDuplicateKey({
        playerId: row.playerMongoId,
        settlementType: "bank",
        settlementAccountId: bankIdStr,
        amount: money.amount,
        transactionAt: entryAt,
        utr: row.utr,
        timeZone: importTimeZone,
      });
    }
    return {
      ...base,
      bankId: new Types.ObjectId(bankIdStr),
      bankName: bankDisplayName(bank),
      bankImpact: true,
    };
  }

  const personIdStr = row.liabilityPersonId?.trim();
  if (!personIdStr) return { error: "Liability person is required" };
  const person = personById.get(personIdStr);
  if (!person) return { error: "Liability person not found" };
  if (!person.isActive) return { error: "Liability person is inactive" };
  if (row.playerMongoId?.trim()) {
    base.duplicateKey = buildTransactionDuplicateKey({
      playerId: row.playerMongoId,
      settlementType: "person",
      settlementAccountId: personIdStr,
      amount: money.amount,
      transactionAt: entryAt,
      utr: row.utr,
      timeZone: importTimeZone,
    });
  }
  return {
    ...base,
    liabilityPersonId: new Types.ObjectId(personIdStr),
    liabilityPersonName: person.name.trim(),
    bankImpact: false,
    bankName: "",
  };
}

function isMongooseBulkWriteError(err: unknown): err is {
  insertedDocs?: unknown[];
  result?: { insertedCount?: number };
  writeErrors?: Array<{ index: number; errmsg?: string; code?: number }>;
} {
  return (
    typeof err === "object" &&
    err !== null &&
    ("writeErrors" in err || "insertedDocs" in err || "result" in err)
  );
}

function bulkWriteErrorMessage(writeError: { errmsg?: string; code?: number }): string {
  if (writeError.code === 11000) return DUPLICATE_TRANSACTION_MESSAGE;
  return writeError.errmsg || "Insert failed";
}

export async function applyDepositImportRows(
  rows: DepositImportCommitRow[],
  actorId: string,
  options?: {
    chunkSize?: number;
    timeZone?: string;
    onProgress?: (progress: DepositImportCommitProgress) => Promise<void> | void;
  },
): Promise<{ created: number; errors: DepositImportCommitError[]; createdIds: string[] }> {
  const actorOid = new Types.ObjectId(actorId);
  const chunkSize = options?.chunkSize ?? DEPOSIT_IMPORT_CHUNK_SIZE;
  const importTimeZone = options?.timeZone ?? DEFAULT_TIMEZONE;
  const totalRows = rows.length;
  let created = 0;
  const errors: DepositImportCommitError[] = [];
  const createdIds: string[] = [];
  const seenDuplicateKeys = new Set<string>();
  const platformCurrency = await requirePlatformCurrency();

  const indexedRows: IndexedDepositImportRow[] = rows.map((row, index) => ({ index, row }));
  const { bankById, personById } = await loadDepositImportLookups(rows);
  const chunks = chunkArray(indexedRows, chunkSize);
  let processedRows = 0;

  for (const chunk of chunks) {
    const pendingInserts: Array<{ doc: Record<string, unknown>; item: IndexedDepositImportRow }> = [];

    for (const item of chunk) {
      if (!item.row.playerMongoId?.trim()) {
        errors.push({ row: item.index + 1, utr: item.row.utr, error: "Player is required" });
        continue;
      }

      const mode = item.row.settlementAccountType ?? "bank";
      const settlementAccountId =
        mode === "bank" ? item.row.bankId?.trim() : item.row.liabilityPersonId?.trim();
      if (!settlementAccountId) {
        errors.push({
          row: item.index + 1,
          utr: item.row.utr,
          error: mode === "bank" ? "Bank is required" : "Liability person is required",
        });
        continue;
      }

      const entryAt = item.row.entryAt
        ? parseBusinessDateTime(item.row.entryAt, "entryAt")
        : new Date();
      const dupInput = {
        playerId: item.row.playerMongoId,
        settlementType: mode as "bank" | "person",
        settlementAccountId,
        amount: item.row.amount,
        transactionAt: entryAt,
        utr: item.row.utr,
        timeZone: importTimeZone,
      };
      const dupKey = buildTransactionDuplicateKey(dupInput);
      if (seenDuplicateKeys.has(dupKey)) {
        errors.push({
          row: item.index + 1,
          utr: item.row.utr,
          error: DUPLICATE_TRANSACTION_MESSAGE,
        });
        continue;
      }

      const existingDup = await findDuplicateTransaction(dupInput);
      if (existingDup) {
        errors.push({
          row: item.index + 1,
          utr: item.row.utr,
          error: DUPLICATE_TRANSACTION_MESSAGE,
        });
        continue;
      }

      const built = buildDepositImportInsertDoc(
        item.row,
        actorOid,
        bankById,
        personById,
        platformCurrency,
        importTimeZone,
      );
      if ("error" in built && typeof built.error === "string") {
        errors.push({ row: item.index + 1, utr: item.row.utr, error: built.error });
        continue;
      }

      seenDuplicateKeys.add(dupKey);
      pendingInserts.push({ doc: built, item });
    }

    if (pendingInserts.length > 0) {
      try {
        const inserted = await DepositModel.insertMany(
          pendingInserts.map((p) => p.doc),
          { ordered: false },
        );
        created += inserted.length;
        for (const doc of inserted) {
          createdIds.push(String(doc._id));
        }
      } catch (err: unknown) {
        if (isMongooseBulkWriteError(err)) {
          const insertedDocs = (err.insertedDocs ?? []) as Array<{ _id?: Types.ObjectId }>;
          const insertedCount = insertedDocs.length || err.result?.insertedCount || 0;
          created += insertedCount;
          for (const doc of insertedDocs) {
            if (doc?._id) createdIds.push(String(doc._id));
          }
          for (const we of err.writeErrors ?? []) {
            const pending = pendingInserts[we.index];
            if (!pending) continue;
            const builtKey = buildTransactionDuplicateKey({
              playerId: pending.item.row.playerMongoId!,
              settlementType: (pending.item.row.settlementAccountType ?? "bank") as "bank" | "person",
              settlementAccountId:
                (pending.item.row.settlementAccountType ?? "bank") === "bank"
                  ? pending.item.row.bankId!
                  : pending.item.row.liabilityPersonId!,
              amount: pending.item.row.amount,
              transactionAt: pending.item.row.entryAt
                ? parseBusinessDateTime(pending.item.row.entryAt, "entryAt")
                : new Date(),
              utr: pending.item.row.utr,
              timeZone: importTimeZone,
            });
            seenDuplicateKeys.delete(builtKey);
            errors.push({
              row: pending.item.index + 1,
              utr: pending.item.row.utr,
              error: bulkWriteErrorMessage(we),
            });
          }
        } else {
          for (const pending of pendingInserts) {
            const builtKey = buildTransactionDuplicateKey({
              playerId: pending.item.row.playerMongoId!,
              settlementType: (pending.item.row.settlementAccountType ?? "bank") as "bank" | "person",
              settlementAccountId:
                (pending.item.row.settlementAccountType ?? "bank") === "bank"
                  ? pending.item.row.bankId!
                  : pending.item.row.liabilityPersonId!,
              amount: pending.item.row.amount,
              transactionAt: pending.item.row.entryAt
                ? parseBusinessDateTime(pending.item.row.entryAt, "entryAt")
                : new Date(),
              utr: pending.item.row.utr,
              timeZone: importTimeZone,
            });
            seenDuplicateKeys.delete(builtKey);
            errors.push({
              row: pending.item.index + 1,
              utr: pending.item.row.utr,
              error: err instanceof Error ? err.message : "Unexpected error",
            });
          }
        }
      }
    }

    processedRows += chunk.length;
    if (options?.onProgress) {
      await options.onProgress({
        totalRows,
        processedRows,
        created,
        errors,
      });
    }
  }

  return { created, errors, createdIds };
}

function scheduleDepositImportSummaryAudit(
  payload: {
    actorId: string;
    requestId?: string;
    created: number;
    failed: number;
    totalRows: number;
  },
): void {
  setImmediate(() => {
    void createAuditLog({
      actorId: payload.actorId,
      action: "deposit.import",
      entity: "deposit",
      entityId: "bulk",
      newValue: {
        created: payload.created,
        failed: payload.failed,
        totalRows: payload.totalRows,
      },
      requestId: payload.requestId,
    }).catch((err) => {
      logger.warn({ err }, "deposit import summary audit failed");
    });
  });
}

export async function commitDepositImportRows(
  rows: DepositImportCommitRow[],
  actorId: string,
  requestId?: string,
  options?: {
    chunkSize?: number;
    timeZone?: string;
    onProgress?: (progress: DepositImportCommitProgress) => Promise<void> | void;
  },
): Promise<{ created: number; errors: DepositImportCommitError[] }> {
  const result = await applyDepositImportRows(rows, actorId, {
    chunkSize: options?.chunkSize ?? DEPOSIT_IMPORT_CHUNK_SIZE,
    timeZone: options?.timeZone,
    onProgress: options?.onProgress,
  });

  // Single-stage import: settle inserted rows that already have player/bonus to verified.
  if (result.createdIds.length > 0) {
    await bulkExchangeApproveDeposits(result.createdIds, actorId, requestId);
  } else if (result.created > 0) {
    emitApprovalQueueEvent("deposit", "exchange");
  }

  scheduleDepositImportSummaryAudit({
    actorId,
    requestId,
    created: result.created,
    failed: result.errors.length,
    totalRows: rows.length,
  });

  return { created: result.created, errors: result.errors };
}

export type DepositImportCommitProgress = {
  totalRows: number;
  processedRows: number;
  created: number;
  errors: Array<{ row: number; utr: string; error: string }>;
};

const DEPOSIT_IMPORT_SAMPLE_COLUMNS = DEPOSIT_IMPORT_CSV_HEADER_LIST;

export async function getDepositImportSampleRows(): Promise<Array<Record<string, string>>> {
  let platformCurrency = "INR";
  try {
    platformCurrency = await requirePlatformCurrency();
  } catch {
    // Template fallback when platform currency is not configured yet.
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const dateAtTen = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} 10:00`;
  return [
    {
      [DEPOSIT_IMPORT_CSV_COLUMNS.entryDateTime]: todayStr,
      [DEPOSIT_IMPORT_CSV_COLUMNS.settlement]: "Bank",
      [DEPOSIT_IMPORT_CSV_COLUMNS.bank]: "1234567890",
      [DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson]: "",
      [DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber]: "TXN001ABC",
      [DEPOSIT_IMPORT_CSV_COLUMNS.operatedCurrency]: "",
      [DEPOSIT_IMPORT_CSV_COLUMNS.amount]: "5000",
      [DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId]: "PLAYER001",
    },
    {
      [DEPOSIT_IMPORT_CSV_COLUMNS.entryDateTime]: "",
      [DEPOSIT_IMPORT_CSV_COLUMNS.settlement]: "Bank",
      [DEPOSIT_IMPORT_CSV_COLUMNS.bank]: "Rajesh Kumar",
      [DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson]: "",
      [DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber]: "TXN002DEF",
      [DEPOSIT_IMPORT_CSV_COLUMNS.operatedCurrency]: "USD",
      [DEPOSIT_IMPORT_CSV_COLUMNS.amount]: "100",
      [DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId]: "PLAYER002",
    },
    {
      [DEPOSIT_IMPORT_CSV_COLUMNS.entryDateTime]: dateAtTen,
      [DEPOSIT_IMPORT_CSV_COLUMNS.settlement]: "Liability person",
      [DEPOSIT_IMPORT_CSV_COLUMNS.bank]: "",
      [DEPOSIT_IMPORT_CSV_COLUMNS.liabilityPerson]: "John Doe",
      [DEPOSIT_IMPORT_CSV_COLUMNS.referenceNumber]: "TXN003GHI",
      [DEPOSIT_IMPORT_CSV_COLUMNS.operatedCurrency]: platformCurrency,
      [DEPOSIT_IMPORT_CSV_COLUMNS.amount]: "2500",
      [DEPOSIT_IMPORT_CSV_COLUMNS.traderWalletId]: "PLAYER003",
    },
  ];
}

export async function buildDepositImportSampleCsv(): Promise<Buffer> {
  const rows = await getDepositImportSampleRows();
  const header = DEPOSIT_IMPORT_SAMPLE_COLUMNS.join(",");
  const lines = rows.map((row) =>
    DEPOSIT_IMPORT_SAMPLE_COLUMNS.map((col) => row[col] ?? "").join(","),
  );
  return Buffer.from([header, ...lines].join("\n"), "utf-8");
}

export async function buildDepositImportSampleXlsx(): Promise<Buffer> {
  const rows = await getDepositImportSampleRows();
  const worksheet = xlsx.utils.json_to_sheet(rows);
  const ref = worksheet["!ref"];
  if (ref) {
    const { e } = xlsx.utils.decode_range(ref);
    for (let rowIndex = 1; rowIndex <= e.r; rowIndex++) {
      const cellRef = xlsx.utils.encode_cell({ r: rowIndex, c: 0 });
      const cell = worksheet[cellRef];
      if (!cell) continue;
      const text = cell.v != null ? String(cell.v) : "";
      worksheet[cellRef] = { t: "s", v: text, w: text, z: "@" };
    }
  }
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Import");
  return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function buildDepositImportErrorCsv(invalidRows: DepositImportInvalidRow[]): Buffer {
  const header = [
    "Row",
    ...DEPOSIT_IMPORT_CSV_HEADER_LIST,
    "Exchange rate",
    "Platform amount",
    "Error",
  ].join(",");
  const lines = [header];
  for (const r of invalidRows) {
    lines.push(
      [
        String(r.row),
        quoteCsvVal(r.dateTime),
        quoteCsvVal(r.settlementType),
        quoteCsvVal(r.bankAccountNumber),
        quoteCsvVal(r.liablePersonName),
        quoteCsvVal(r.utr),
        quoteCsvVal(r.operatedCurrency),
        quoteCsvVal(r.amount),
        quoteCsvVal(r.playerId),
        quoteCsvVal(r.exchangeRate),
        quoteCsvVal(r.platformAmount),
        quoteCsvVal(r.errors.join("; ")),
      ].join(","),
    );
  }
  return Buffer.from(lines.join("\n"), "utf-8");
}

function quoteCsvVal(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
