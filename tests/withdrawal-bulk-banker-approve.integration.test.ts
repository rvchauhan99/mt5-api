import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { bulkBankerApproveWithdrawals } from "../src/modules/withdrawal/withdrawal.service";

function flushBackgroundTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("withdrawal bulk banker approve", () => {
  let mongo: MongoMemoryServer;
  let actorId = "";
  let payoutBankId = "";
  let playerId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const exchange = await ExchangeModel.create({
      name: "Bulk WDR Exchange",
      provider: "Test",
      openingBalance: 0,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "BULK-WDR-1",
      phone: "9222222222",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerId = String(player._id);

    const bank = await BankModel.create({
      holderName: "Bulk Payout Bank",
      bankName: "BP Bank",
      accountNumber: "888888888801",
      ifsc: "BPBK0000888",
      openingBalance: 50_000,
      currentBalance: 50_000,
      status: "active",
      createdBy: actorId,
    });
    payoutBankId = String(bank._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await WithdrawalModel.deleteMany({});
  });

  it("approves requested withdrawals that have import payout prefilled", async () => {
    const withdrawals = await WithdrawalModel.create(
      [1, 2].map((n) => ({
        player: new mongoose.Types.ObjectId(playerId),
        playerName: "BULK-WDR-1 · 9222222222",
        accountNumber: `ACC${n}`,
        accountHolderName: `Holder ${n}`,
        bankName: "Dest Bank",
        ifsc: "DEST0001234",
        amount: 1000 * n,
        reverseBonus: 0,
        payableAmount: 1000 * n,
        payoutSettlementType: "bank",
        payoutBankId: new mongoose.Types.ObjectId(payoutBankId),
        payoutBankName: "Bulk Payout Bank",
        utr: `WDR-BULK-00${n}`,
        status: "requested",
        createdBy: new mongoose.Types.ObjectId(actorId),
      })),
    );

    const result = await bulkBankerApproveWithdrawals(
      withdrawals.map((w) => String(w._id)),
      actorId,
    );

    expect(result.approved).toBe(2);
    expect(result.failed).toHaveLength(0);

    const approved = await WithdrawalModel.countDocuments({ status: "approved" });
    expect(approved).toBe(2);
  });

  it("skips withdrawals without payout prefill and reports partial failure", async () => {
    const ready = await WithdrawalModel.create({
      player: new mongoose.Types.ObjectId(playerId),
      playerName: "BULK-WDR-1 · 9222222222",
      accountNumber: "ACC-READY",
      accountHolderName: "Ready Holder",
      bankName: "Dest Bank",
      ifsc: "DEST0001234",
      amount: 500,
      reverseBonus: 0,
      payableAmount: 500,
      payoutSettlementType: "bank",
      payoutBankId: new mongoose.Types.ObjectId(payoutBankId),
      payoutBankName: "Bulk Payout Bank",
      utr: "WDR-READY-001",
      status: "requested",
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    const notReady = await WithdrawalModel.create({
      player: new mongoose.Types.ObjectId(playerId),
      playerName: "BULK-WDR-1 · 9222222222",
      accountNumber: "ACC-NO-UTR",
      accountHolderName: "No UTR",
      bankName: "Dest Bank",
      ifsc: "DEST0001234",
      amount: 800,
      reverseBonus: 0,
      payableAmount: 800,
      status: "requested",
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    const result = await bulkBankerApproveWithdrawals(
      [String(ready._id), String(notReady._id)],
      actorId,
    );

    expect(result.approved).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.withdrawalId).toBe(String(notReady._id));
    expect(result.failed[0]?.error).toMatch(/no payout UTR/i);

    const readyDoc = await WithdrawalModel.findById(ready._id).lean();
    const notReadyDoc = await WithdrawalModel.findById(notReady._id).lean();
    expect(readyDoc?.status).toBe("approved");
    expect(notReadyDoc?.status).toBe("requested");
  });

  it("writes summary audit in the background when at least one succeeds", async () => {
    const { AuditLogModel } = await import("../src/modules/audit/audit.model");
    await AuditLogModel.deleteMany({ action: "withdrawal.bulk_banker_approve" });

    const withdrawal = await WithdrawalModel.create({
      player: new mongoose.Types.ObjectId(playerId),
      playerName: "BULK-WDR-1 · 9222222222",
      accountNumber: "ACC-AUDIT",
      accountHolderName: "Audit Holder",
      bankName: "Dest Bank",
      ifsc: "DEST0001234",
      amount: 100,
      reverseBonus: 0,
      payableAmount: 100,
      payoutSettlementType: "bank",
      payoutBankId: new mongoose.Types.ObjectId(payoutBankId),
      payoutBankName: "Bulk Payout Bank",
      utr: "WDR-AUDIT-001",
      status: "requested",
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    await bulkBankerApproveWithdrawals([String(withdrawal._id)], actorId);
    await flushBackgroundTasks();

    const summary = await AuditLogModel.findOne({ action: "withdrawal.bulk_banker_approve" }).lean();
    expect(summary).toBeTruthy();
    expect((summary?.newValue as { approved?: number })?.approved).toBe(1);
  });
});
