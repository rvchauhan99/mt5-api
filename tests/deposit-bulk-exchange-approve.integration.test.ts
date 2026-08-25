import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { bulkExchangeApproveDeposits } from "../src/modules/deposit/deposit.service";

function flushBackgroundTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("deposit bulk exchange approve", () => {
  let mongo: MongoMemoryServer;
  let actorId = "";
  let bankId = "";
  let playerId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const exchange = await ExchangeModel.create({
      name: "Bulk Approve Exchange",
      provider: "Test",
      openingBalance: 0,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "BULK-PL-1",
      phone: "9111111111",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerId = String(player._id);

    const bank = await BankModel.create({
      holderName: "Bulk Approve Bank",
      bankName: "BA Bank",
      accountNumber: "777777777701",
      ifsc: "BABK0000777",
      openingBalance: 50_000,
      currentBalance: 50_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await DepositModel.deleteMany({});
  });

  it("approves pending deposits that have player and bonus from import", async () => {
    const deposits = await DepositModel.create(
      [1, 2, 3].map((n) => ({
        settlementAccountType: "bank",
        bankId: new mongoose.Types.ObjectId(bankId),
        bankName: "Bulk Approve Bank",
        utr: `BULK-APPROVE-00${n}`,
        amount: 1000 * n,
        bonusAmount: 50 * n,
        totalAmount: 1000 * n + 50 * n,
        status: "pending",
        player: new mongoose.Types.ObjectId(playerId),
        createdBy: new mongoose.Types.ObjectId(actorId),
        bankImpact: true,
      })),
    );

    const result = await bulkExchangeApproveDeposits(
      deposits.map((d) => String(d._id)),
      actorId,
    );

    expect(result.approved).toBe(3);
    expect(result.failed).toHaveLength(0);

    const verified = await DepositModel.countDocuments({ status: "verified" });
    expect(verified).toBe(3);

    const bank = await BankModel.findById(bankId).lean();
    expect(bank?.currentBalance).toBe(50_000 + 1000 + 2000 + 3000);
  });

  it("skips deposits without player and reports partial failure", async () => {
    const ready = await DepositModel.create({
      settlementAccountType: "bank",
      bankId: new mongoose.Types.ObjectId(bankId),
      bankName: "Bulk Approve Bank",
      utr: "BULK-READY-001",
      amount: 500,
      bonusAmount: 25,
      totalAmount: 525,
      status: "pending",
      player: new mongoose.Types.ObjectId(playerId),
      createdBy: new mongoose.Types.ObjectId(actorId),
      bankImpact: true,
    });

    const notReady = await DepositModel.create({
      settlementAccountType: "bank",
      bankId: new mongoose.Types.ObjectId(bankId),
      bankName: "Bulk Approve Bank",
      utr: "BULK-NO-PLAYER-001",
      amount: 800,
      status: "pending",
      createdBy: new mongoose.Types.ObjectId(actorId),
      bankImpact: true,
    });

    const result = await bulkExchangeApproveDeposits(
      [String(ready._id), String(notReady._id)],
      actorId,
    );

    expect(result.approved).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.depositId).toBe(String(notReady._id));
    expect(result.failed[0]?.error).toMatch(/no player/i);

    const readyDoc = await DepositModel.findById(ready._id).lean();
    const notReadyDoc = await DepositModel.findById(notReady._id).lean();
    expect(readyDoc?.status).toBe("verified");
    expect(notReadyDoc?.status).toBe("pending");
  });

  it("writes summary audit in the background when at least one succeeds", async () => {
    const { AuditLogModel } = await import("../src/modules/audit/audit.model");
    await AuditLogModel.deleteMany({ action: "deposit.bulk_exchange_approve" });

    const deposit = await DepositModel.create({
      settlementAccountType: "bank",
      bankId: new mongoose.Types.ObjectId(bankId),
      bankName: "Bulk Approve Bank",
      utr: "BULK-AUDIT-001",
      amount: 100,
      bonusAmount: 10,
      totalAmount: 110,
      status: "pending",
      player: new mongoose.Types.ObjectId(playerId),
      createdBy: new mongoose.Types.ObjectId(actorId),
      bankImpact: true,
    });

    await bulkExchangeApproveDeposits([String(deposit._id)], actorId);
    await flushBackgroundTasks();

    const summary = await AuditLogModel.findOne({ action: "deposit.bulk_exchange_approve" }).lean();
    expect(summary).toBeTruthy();
    expect((summary?.newValue as { approved?: number })?.approved).toBe(1);
  });
});
