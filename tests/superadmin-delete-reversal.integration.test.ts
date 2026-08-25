import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { signAccessToken } from "../src/shared/utils/jwt";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { AuditLogModel } from "../src/modules/audit/audit.model";

describe("Superadmin delete with reversal integration", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let superadminToken = "";
  let actorId = "";
  let subAdminToken = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const loginRes = await request(app).post("/api/v1/auth/login").send({
      username: "superadmin",
      password: "SuperAdmin@123",
    });
    superadminToken = loginRes.body.data.accessToken;

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const subAdmin = await UserModel.create({
      fullName: "Delete Test SubAdmin",
      email: "delete.subadmin@example.com",
      username: "delete_subadmin",
      passwordHash: "not-used",
      role: "sub_admin",
      status: "active",
      permissions: [],
      timezone: "Asia/Kolkata",
      createdBy: actor!._id,
    });
    subAdminToken = signAccessToken({
      userId: String(subAdmin._id),
      role: "sub_admin",
      permissions: [],
      timezone: "Asia/Kolkata",
    });
  });

  beforeEach(async () => {
    await Promise.all([
      DepositModel.deleteMany({}),
      WithdrawalModel.deleteMany({}),
      PlayerModel.deleteMany({}),
      ExchangeModel.deleteMany({}),
      BankModel.deleteMany({}),
      AuditLogModel.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function seedCore() {
    const bank = await BankModel.create({
      holderName: "Delete Bank Holder",
      bankName: "Delete Bank",
      accountNumber: "888877776666",
      ifsc: "BKID0000888",
      openingBalance: 1000,
      currentBalance: 1000,
      status: "active",
      createdBy: actorId,
    });

    const exchange = await ExchangeModel.create({
      name: "Delete Exchange",
      provider: "Delete Provider",
      openingBalance: 5000,
      currentBalance: 5000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "DEL-PLAYER-001",
      phone: "9000001111",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });

    return { bank, exchange, player };
  }

  it("forbids non-superadmin from deleting deposit and withdrawal", async () => {
    const { bank, player } = await seedCore();

    const depRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ bankId: String(bank._id), utr: "DEL-DEP-FORBID-001", amount: 100 });
    const depositId = String(depRes.body.data._id);

    const wRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        playerId: String(player._id),
        accountNumber: "123123123123",
        accountHolderName: "Delete Test",
        bankName: "Delete Test Bank",
        ifsc: "BKID0000123",
        amount: 150,
        reverseBonus: 10,
      });
    const withdrawalId = String(wRes.body.data._id);

    const depDelete = await request(app)
      .delete(`/api/v1/deposit/${depositId}`)
      .set("Authorization", `Bearer ${subAdminToken}`);
    expect(depDelete.status).toBe(403);

    const wDelete = await request(app)
      .delete(`/api/v1/withdrawal/${withdrawalId}`)
      .set("Authorization", `Bearer ${subAdminToken}`);
    expect(wDelete.status).toBe(403);
  });

  it("deletes verified deposit and reverses bank/exchange with audit", async () => {
    const { bank, exchange, player } = await seedCore();

    const createRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        bankId: String(bank._id),
        utr: "DEL-DEP-VERIFY-001",
        amount: 400,
      });
    expect(createRes.status).toBe(201);
    const depositId = String(createRes.body.data._id);

    const approveRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/exchange-action`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        action: "approve",
        playerId: String(player._id),
        bonusAmount: 40,
      });
    expect(approveRes.status).toBe(200);

    const bankAfterApprove = await BankModel.findById(bank._id).lean();
    expect(Number(bankAfterApprove?.currentBalance)).toBe(1400);
    const exchangeAfterApprove = await ExchangeModel.findById(exchange._id).lean();
    expect(Number(exchangeAfterApprove?.currentBalance)).toBe(4560);

    const deleteRes = await request(app)
      .delete(`/api/v1/deposit/${depositId}`)
      .set("Authorization", `Bearer ${superadminToken}`);
    expect(deleteRes.status).toBe(200);

    const deleted = await DepositModel.findById(depositId).lean();
    expect(deleted).toBeNull();

    const bankAfterDelete = await BankModel.findById(bank._id).lean();
    expect(Number(bankAfterDelete?.currentBalance)).toBe(1000);
    const exchangeAfterDelete = await ExchangeModel.findById(exchange._id).lean();
    expect(Number(exchangeAfterDelete?.currentBalance)).toBe(5000);

    const audit = await AuditLogModel.findOne({ action: "deposit.delete", entityId: depositId }).lean();
    expect(audit).toBeTruthy();
  });

  it("deletes approved withdrawal and reverses exchange plus normalizes bank with audit", async () => {
    const { bank, exchange, player } = await seedCore();

    const createRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        playerId: String(player._id),
        accountNumber: "232323232323",
        accountHolderName: "Delete Withdrawal Holder",
        bankName: "Delete Withdrawal Bank",
        ifsc: "BKID0000232",
        amount: 300,
        reverseBonus: 20,
      });
    expect(createRes.status).toBe(201);
    const withdrawalId = String(createRes.body.data._id);

    const approveRes = await request(app)
      .patch(`/api/v1/withdrawal/${withdrawalId}/banker-payout`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        bankId: String(bank._id),
        utr: "DEL-WDR-APR-001",
      });
    expect(approveRes.status).toBe(200);

    const exchangeAfterApprove = await ExchangeModel.findById(exchange._id);
    expect(Number(exchangeAfterApprove?.currentBalance)).toBe(5000);
    if (exchangeAfterApprove) {
      exchangeAfterApprove.currentBalance = 1234;
      await exchangeAfterApprove.save();
    }

    const deleteRes = await request(app)
      .delete(`/api/v1/withdrawal/${withdrawalId}`)
      .set("Authorization", `Bearer ${superadminToken}`);
    expect(deleteRes.status).toBe(200);

    const deleted = await WithdrawalModel.findById(withdrawalId).lean();
    expect(deleted).toBeNull();

    const exchangeAfterDelete = await ExchangeModel.findById(exchange._id).lean();
    expect(Number(exchangeAfterDelete?.currentBalance)).toBe(5000);
    const bankAfterDelete = await BankModel.findById(bank._id).lean();
    expect(Number(bankAfterDelete?.currentBalance)).toBe(1000);

    const audit = await AuditLogModel.findOne({ action: "withdrawal.delete", entityId: withdrawalId }).lean();
    expect(audit).toBeTruthy();
  });
});
