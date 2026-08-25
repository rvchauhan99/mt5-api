import mongoose, { Types } from "mongoose";
import { AppError } from "../../shared/errors/AppError";
import { createAuditLog } from "../audit/audit.service";
import { DepositModel } from "../deposit/deposit.model";
import { PlayerModel } from "../player/player.model";
import { ReferralAccrualModel } from "./referral-accrual.model";
import { decodeTimeCursor, encodeTimeCursor } from "../../shared/utils/cursorPagination";
import { enqueueExchangeRecompute } from "../../shared/queue/queue";
import { invalidateCacheDomains } from "../../shared/cache/domainCache";

function referralAmount(amount: number, percentage: number): number {
  return Math.round((Number(amount) * Number(percentage)) / 100);
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
  input: { accrualIds: string[]; remark?: string },
  actorId: string,
  requestId?: string,
) {
  const ids = Array.from(new Set(input.accrualIds.filter((x) => Types.ObjectId.isValid(x)))).map((x) => new Types.ObjectId(x));
  if (ids.length === 0) {
    throw new AppError("validation_error", "At least one valid accrual id is required", 400);
  }

  const session = await mongoose.startSession();
  let settledDepositId = "";
  let exchangeId = "";
  let totalAmount = 0;
  try {
    await session.withTransaction(async () => {
      const rows = await ReferralAccrualModel.find({ _id: { $in: ids } }).session(session);
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

      totalAmount = rows.reduce((sum, row) => sum + Number(row.accruedAmount ?? 0), 0);
      if (totalAmount <= 0) {
        throw new AppError("business_rule_error", "Settlement amount must be greater than zero", 400);
      }

      const settlementUtr = `REFSET-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const [settlementDeposit] = await DepositModel.create(
        [
          {
            bankName: "",
            utr: settlementUtr,
            amount: totalAmount,
            status: "verified",
            createdBy: new Types.ObjectId(actorId),
            player: new Types.ObjectId(referrerKey),
            bonusAmount: totalAmount,
            totalAmount,
            exchangeActionBy: new Types.ObjectId(actorId),
            exchangeActionAt: new Date(),
            entryAt: new Date(),
            settledAt: new Date(),
            bankImpact: false,
            isReferralSettlement: true,
            referralSettlementRemark: input.remark?.trim() || undefined,
          },
        ],
        { session },
      );

      settledDepositId = String(settlementDeposit._id);
      exchangeId = exchangeKey;

      await ReferralAccrualModel.updateMany(
        { _id: { $in: ids } },
        {
          $set: {
            status: "settled",
            settledAt: new Date(),
            settledBy: new Types.ObjectId(actorId),
            settlementDepositId: settlementDeposit._id,
          },
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  await enqueueExchangeRecompute(exchangeId);
  await invalidateCacheDomains(["referral", "deposit", "exchange", "player"]);

  await createAuditLog({
    actorId,
    action: "referral.settle",
    entity: "referral_accrual",
    entityId: settledDepositId,
    newValue: {
      settlementDepositId: settledDepositId,
      settledAccrualCount: ids.length,
      totalAmount,
      remark: input.remark?.trim() || undefined,
    },
    requestId,
  });

  return {
    settlementDepositId: settledDepositId,
    settledAccrualCount: ids.length,
    totalAmount,
  };
}
