import { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { BankModel } from "../bank/bank.model";
import { DepositModel } from "../deposit/deposit.model";
import { createLiabilityEntry, deleteLiabilityEntryForReversal } from "../liability/liability.service";
import { LiabilityPersonModel } from "../liability/liability-person.model";
import { PlayerModel } from "../player/player.model";
import { ReferralAccrualModel } from "./referral-accrual.model";
import { decodeTimeCursor, encodeTimeCursor } from "../../shared/utils/cursorPagination";
import { enqueueExchangeRecompute } from "../../shared/queue/queue";
import { invalidateCacheDomains } from "../../shared/cache/domainCache";
import { DEFAULT_TIMEZONE, formatDateForTimeZone } from "../../shared/utils/timezone";

function bankDisplayName(b: { holderName: string; bankName: string; accountNumber: string }): string {
  const last4 = String(b.accountNumber ?? "").slice(-4);
  return `${b.holderName} — ${b.bankName}${last4 ? ` (${last4})` : ""}`.trim();
}
function referralAmount(amount: number, percentage: number): number {
  return Math.round((Number(amount) * Number(percentage)) / 100);
}

function referralPercentageFromAmount(depositAmount: number, accruedAmount: number): number {
  if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
    throw new AppError("validation_error", "Cannot derive referral percentage when source deposit amount is 0", 400);
  }
  const pct = (Number(accruedAmount) / Number(depositAmount)) * 100;
  if (!Number.isFinite(pct)) {
    throw new AppError("validation_error", "Invalid accrued amount", 400);
  }
  const rounded = Math.round(pct * 100) / 100;
  if (rounded < 0 || rounded > 100) {
    throw new AppError("validation_error", "Derived referral percentage must be between 0 and 100", 400);
  }
  return rounded;
}

export async function updateReferralAccrual(
  id: string,
  input: { referralPercentage?: number; accruedAmount?: number },
  actorId: string,
  requestId?: string,
) {
  if (!Types.ObjectId.isValid(id)) {
    throw new AppError("validation_error", "Invalid accrual id", 400);
  }

  const doc = await ReferralAccrualModel.findById(id);
  if (!doc) {
    throw new AppError("not_found", "Referral accrual not found", 404);
  }
  if (doc.status !== "accrued") {
    throw new AppError("business_rule_error", "Only accrued records can be edited", 400);
  }

  const sourceDepositAmount = Number(doc.sourceDepositAmount ?? 0);
  const oldValue = {
    referralPercentage: doc.referralPercentage,
    accruedAmount: doc.accruedAmount,
  };

  let nextPercentage = Number(doc.referralPercentage ?? 0);
  let nextAccrued = Number(doc.accruedAmount ?? 0);

  if (input.referralPercentage !== undefined) {
    nextPercentage = Number(input.referralPercentage);
    if (!Number.isFinite(nextPercentage) || nextPercentage < 0 || nextPercentage > 100) {
      throw new AppError("validation_error", "Referral percentage must be between 0 and 100", 400);
    }
    nextAccrued = referralAmount(sourceDepositAmount, nextPercentage);
  } else if (input.accruedAmount !== undefined) {
    nextAccrued = Number(input.accruedAmount);
    if (!Number.isFinite(nextAccrued) || nextAccrued < 0) {
      throw new AppError("validation_error", "Accrued amount must be a number ≥ 0", 400);
    }
    if (!Number.isInteger(nextAccrued)) {
      throw new AppError("validation_error", "Accrued amount must be a whole number", 400);
    }
    nextPercentage = referralPercentageFromAmount(sourceDepositAmount, nextAccrued);
  } else {
    throw new AppError("validation_error", "Provide exactly one of referralPercentage or accruedAmount", 400);
  }

  doc.referralPercentage = nextPercentage;
  doc.accruedAmount = nextAccrued;
  await doc.save();

  await createAuditLog({
    actorId,
    action: "referral.accrual.update",
    entity: "referral_accrual",
    entityId: doc._id.toString(),
    oldValue,
    newValue: {
      referralPercentage: doc.referralPercentage,
      accruedAmount: doc.accruedAmount,
    },
    requestId,
  });

  const populated = await ReferralAccrualModel.findById(doc._id)
    .populate("referrerPlayerId", "playerId phone exchange")
    .populate("referredPlayerId", "playerId phone exchange")
    .populate("exchangeId", "name provider")
    .populate("sourceDepositId", "utr amount status entryAt")
    .populate("settlementDepositId", "utr amount entryAt")
    .lean();

  return populated ?? doc.toObject();
}

export async function syncReferralAccrualForDeposit(sourceDepositId: Types.ObjectId): Promise<void> {
  const deposit = await DepositModel.findById(sourceDepositId).select("_id player amount status");
  if (!deposit || !deposit.player || !["verified", "finalized"].includes(String(deposit.status))) {
    return;
  }

  const referredPlayer = await PlayerModel.findById(deposit.player).select("referredByPlayerId referralPercentage");
  if (!referredPlayer?.referredByPlayerId) {
    await ReferralAccrualModel.updateOne(
      { sourceDepositId: deposit._id, status: "accrued" },
      { $set: { status: "cancelled", cancelledReason: "Referred player has no referrer configured" } },
    );
    return;
  }

  const referrer = await PlayerModel.findById(referredPlayer.referredByPlayerId).select("exchange");
  if (!referrer?.exchange) {
    throw new AppError("business_rule_error", "Referrer player has no exchange assigned", 400);
  }

  const percentage = Number(referredPlayer.referralPercentage ?? 1);
  const accruedAmount = referralAmount(Number(deposit.amount ?? 0), percentage);

  const existing = await ReferralAccrualModel.findOne({ sourceDepositId: deposit._id });
  if (existing?.status === "settled") {
    throw new AppError("business_rule_error", "Cannot amend deposit after referral accrual is settled", 400);
  }

  await ReferralAccrualModel.updateOne(
    { sourceDepositId: deposit._id },
    {
      $set: {
        referrerPlayerId: referredPlayer.referredByPlayerId,
        referredPlayerId: deposit.player,
        exchangeId: referrer.exchange,
        sourceDepositAmount: Number(deposit.amount ?? 0),
        referralPercentage: percentage,
        accruedAmount,
        status: "accrued",
        cancelledReason: undefined,
        settledAt: undefined,
        settledBy: undefined,
        settlementDepositId: undefined,
      },
      $setOnInsert: {
        sourceDepositId: deposit._id,
      },
    },
    { upsert: true },
  );
}

export async function cancelReferralAccrualForDeposit(
  sourceDepositId: Types.ObjectId,
  reason: string,
): Promise<void> {
  const existing = await ReferralAccrualModel.findOne({ sourceDepositId });
  if (!existing) return;
  if (existing.status === "settled") {
    throw new AppError("business_rule_error", "Cannot modify deposit after referral accrual is settled", 400);
  }
  await ReferralAccrualModel.updateOne(
    { _id: existing._id },
    { $set: { status: "cancelled", cancelledReason: reason } },
  );
}

export async function ensureDepositReferralAccrualMutable(sourceDepositId: Types.ObjectId): Promise<void> {
  const existing = await ReferralAccrualModel.findOne({ sourceDepositId }).select("status");
  if (existing?.status === "settled") {
    throw new AppError("business_rule_error", "Cannot modify deposit after referral accrual is settled", 400);
  }
}

export async function listReferralAccruals(query: {
  page: number;
  pageSize: number;
  cursor?: string;
  status?: "accrued" | "settled" | "cancelled";
  referrerPlayerId?: string;
  referredPlayerId?: string;
  exchangeId?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.referrerPlayerId) filter.referrerPlayerId = new Types.ObjectId(query.referrerPlayerId);
  if (query.referredPlayerId) filter.referredPlayerId = new Types.ObjectId(query.referredPlayerId);
  if (query.exchangeId) filter.exchangeId = new Types.ObjectId(query.exchangeId);

  const skip = (query.page - 1) * query.pageSize;
  const cursor = decodeTimeCursor(query.cursor);
  const queryFilter: Record<string, unknown> = { ...filter };
  if (cursor) {
    const cursorDate = new Date(cursor.t);
    if (!Number.isNaN(cursorDate.getTime()) && Types.ObjectId.isValid(cursor.id)) {
      queryFilter.$or = [
        { createdAt: { $lt: cursorDate } },
        { createdAt: cursorDate, _id: { $lt: new Types.ObjectId(cursor.id) } },
      ];
    }
  }
  const [rows, total] = await Promise.all([
    ReferralAccrualModel.find(queryFilter)
      .populate("referrerPlayerId", "playerId phone exchange")
      .populate("referredPlayerId", "playerId phone exchange")
      .populate("exchangeId", "name provider")
      .populate("sourceDepositId", "utr amount status entryAt")
      .populate("settlementDepositId", "utr amount entryAt")
      .sort({ createdAt: -1 })
      .skip(cursor ? 0 : skip)
      .limit(query.pageSize)
      .lean(),
    ReferralAccrualModel.countDocuments(filter),
  ]);

  const lastRow = rows[rows.length - 1] as { _id?: unknown; createdAt?: Date } | undefined;
  return {
    rows,
    meta: {
      total,
      page: query.page,
      pageSize: query.pageSize,
      ...(cursor && lastRow?._id && lastRow.createdAt
        ? { nextCursor: encodeTimeCursor({ t: lastRow.createdAt, id: String(lastRow._id) }) }
        : {}),
    },
  };
}

export async function settleReferralAccruals(
  input:
    | {
        accrualIds: string[];
        remark?: string;
        settlementAccountType: "bank";
        bankId: string;
      }
    | {
        accrualIds: string[];
        remark?: string;
        settlementAccountType: "person";
        liabilityPersonId: string;
      },
  actorId: string,
  requestId?: string,
) {
  const ids = Array.from(new Set(input.accrualIds.filter((x) => Types.ObjectId.isValid(x)))).map((x) => new Types.ObjectId(x));
  if (ids.length === 0) {
    throw new AppError("validation_error", "At least one valid accrual id is required", 400);
  }

  const rows = await ReferralAccrualModel.find({ _id: { $in: ids } });
  if (rows.length !== ids.length) {
    throw new AppError("not_found", "One or more accrual records were not found", 404);
  }
  if (rows.some((r) => r.status !== "accrued")) {
    throw new AppError("business_rule_error", "Only accrued records can be settled", 400);
  }

  const referrerKey = String(rows[0].referrerPlayerId);
  const exchangeKey = String(rows[0].exchangeId);
  if (rows.some((r) => String(r.referrerPlayerId) !== referrerKey || String(r.exchangeId) !== exchangeKey)) {
    throw new AppError("business_rule_error", "All accruals must belong to the same referrer and exchange", 400);
  }

  const totalAmount = rows.reduce((sum, row) => sum + Number(row.accruedAmount ?? 0), 0);
  if (totalAmount <= 0) {
    throw new AppError("business_rule_error", "Settlement amount must be greater than zero", 400);
  }

  const remark = input.remark?.trim() || undefined;
  const settledAt = new Date();
  const primaryAccrualId = String(ids[0]);

  if (input.settlementAccountType === "bank") {
    const bank = await BankModel.findById(input.bankId);
    if (!bank) throw new AppError("not_found", "Bank not found", 404);
    if (bank.status !== "active") throw new AppError("business_rule_error", "Bank is not active", 400);

    const prevBal = Number(bank.currentBalance ?? bank.openingBalance ?? 0);
    if (totalAmount > prevBal) {
      throw new AppError("business_rule_error", "Insufficient bank balance for this referral settlement", 400);
    }

    const bankBalanceAfter = prevBal - totalAmount;
    bank.currentBalance = bankBalanceAfter;
    await bank.save();

    try {
      const updateResult = await ReferralAccrualModel.updateMany(
        { _id: { $in: ids }, status: "accrued" },
        {
          $set: {
            status: "settled",
            settledAt,
            settledBy: new Types.ObjectId(actorId),
            settlementAccountType: "bank",
            bankId: bank._id,
            bankName: bankDisplayName(bank),
            bankBalanceAfter,
            settlementRemark: remark,
            liabilityPersonId: undefined,
            liabilityPersonName: "",
            liabilityEntryId: undefined,
          },
          $unset: { settlementDepositId: 1 },
        },
      );

      if (updateResult.modifiedCount !== ids.length) {
        bank.currentBalance = prevBal;
        await bank.save();
        throw new AppError(
          "business_rule_error",
          "Settlement conflict: one or more accruals were already settled or changed",
          409,
        );
      }
    } catch (err) {
      if (!(err instanceof AppError && err.statusCode === 409)) {
        bank.currentBalance = prevBal;
        await bank.save().catch(() => undefined);
      }
      throw err;
    }

    await enqueueExchangeRecompute(exchangeKey);
    await invalidateCacheDomains(["referral", "bank", "liability", "exchange", "player"]);

    await createAuditLog({
      actorId,
      action: "referral.settle",
      entity: "referral_accrual",
      entityId: primaryAccrualId,
      newValue: {
        accrualIds: ids.map((id) => String(id)),
        settledAccrualCount: ids.length,
        totalAmount,
        settlementAccountType: "bank",
        bankId: String(bank._id),
        bankBalanceAfter,
        remark,
      },
      requestId,
    });

    return {
      settledAccrualCount: ids.length,
      totalAmount,
      settlementAccountType: "bank" as const,
      bankId: String(bank._id),
      bankBalanceAfter,
    };
  }

  const person = await LiabilityPersonModel.findById(input.liabilityPersonId);
  if (!person) throw new AppError("not_found", "Liability person not found", 404);
  if (!person.isActive) throw new AppError("business_rule_error", "Liability person is inactive", 400);

  const updateResult = await ReferralAccrualModel.updateMany(
    { _id: { $in: ids }, status: "accrued" },
    {
      $set: {
        status: "settled",
        settledAt,
        settledBy: new Types.ObjectId(actorId),
        settlementAccountType: "person",
        liabilityPersonId: person._id,
        liabilityPersonName: person.name,
        settlementRemark: remark,
        bankId: undefined,
        bankName: "",
        bankBalanceAfter: undefined,
      },
      $unset: { settlementDepositId: 1 },
    },
  );

  if (updateResult.modifiedCount !== ids.length) {
    throw new AppError(
      "business_rule_error",
      "Settlement conflict: one or more accruals were already settled or changed",
      409,
    );
  }

  let liabilityEntryId = "";
  try {
    const entryYmd = formatDateForTimeZone(settledAt, DEFAULT_TIMEZONE) || settledAt.toISOString().slice(0, 10);
    const referenceNo = `REFSET-${primaryAccrualId.slice(-8).toUpperCase()}`;
    const liabilityEntry = await createLiabilityEntry(
      {
        entryDate: entryYmd,
        entryType: "journal",
        amount: totalAmount,
        fromAccountType: "person",
        fromAccountId: String(person._id),
        toAccountType: "referral",
        toAccountId: primaryAccrualId,
        sourceType: "referral",
        sourceReferralAccrualId: primaryAccrualId,
        referenceNo,
        remark: remark || `IB referral settlement (${ids.length} accrual${ids.length === 1 ? "" : "s"})`,
      },
      actorId,
      requestId,
    );
    liabilityEntryId = String(liabilityEntry._id);
    await ReferralAccrualModel.updateMany(
      { _id: { $in: ids } },
      { $set: { liabilityEntryId: liabilityEntry._id } },
    );
  } catch (err) {
    await ReferralAccrualModel.updateMany(
      { _id: { $in: ids }, status: "settled" },
      {
        $set: {
          status: "accrued",
          liabilityPersonName: "",
          bankName: "",
        },
        $unset: {
          settledAt: 1,
          settledBy: 1,
          settlementAccountType: 1,
          liabilityPersonId: 1,
          liabilityEntryId: 1,
          settlementRemark: 1,
          bankId: 1,
          bankBalanceAfter: 1,
        },
      },
    );
    if (liabilityEntryId) {
      await deleteLiabilityEntryForReversal(liabilityEntryId, actorId, requestId).catch(() => undefined);
    }
    throw err;
  }

  await enqueueExchangeRecompute(exchangeKey);
  await invalidateCacheDomains(["referral", "bank", "liability", "exchange", "player"]);

  await createAuditLog({
    actorId,
    action: "referral.settle",
    entity: "referral_accrual",
    entityId: primaryAccrualId,
    newValue: {
      accrualIds: ids.map((id) => String(id)),
      settledAccrualCount: ids.length,
      totalAmount,
      settlementAccountType: "person",
      liabilityPersonId: String(person._id),
      liabilityEntryId,
      remark,
    },
    requestId,
  });

  return {
    settledAccrualCount: ids.length,
    totalAmount,
    settlementAccountType: "person" as const,
    liabilityPersonId: String(person._id),
    liabilityEntryId,
  };
}
