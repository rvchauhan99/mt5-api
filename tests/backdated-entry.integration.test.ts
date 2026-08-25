import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { ReasonModel } from "../src/modules/masters/reason.model";
import { REASON_TYPES } from "../src/shared/constants/reasonTypes";

describe("Backdated entry datetime integration", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let bankId = "";
  let playerId = "";
  let depositAmendReasonId = "";
  let withdrawalAmendReasonId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const loginRes = await request(app).post("/api/v1/auth/login").send({
      username: "superadmin",
      password: "SuperAdmin@123",
    });
    accessToken = loginRes.body.data.accessToken;

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const bank = await BankModel.create({
      holderName: "Backdated Banker",
      bankName: "Backdated Bank",
      accountNumber: "123456789012",
      ifsc: "BKID0000123",
      openingBalance: 1000,
      currentBalance: 1000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const exchange = await ExchangeModel.create({
      name: "Backdated Exchange",
      provider: "Backdated Provider",
      openingBalance: 5000,
      currentBalance: 5000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "BD-PLAYER-001",
      phone: "9000000009",
      regularBonusPercentage: 5,
      firstDepositBonusPercentage: 10,
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerId = String(player._id);

    const [depositAmendReason, withdrawalAmendReason] = await ReasonModel.create([
      {
        reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
        reason: "Deposit amend test reason",
        description: "Automated test",
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      },
      {
        reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
        reason: "Withdrawal amend test reason",
        description: "Automated test",
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      },
    ]);
    depositAmendReasonId = String(depositAmendReason._id);
    withdrawalAmendReasonId = String(withdrawalAmendReason._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("creates deposit with explicit backdated entryAt", async () => {
    const explicitEntryAt = "2026-04-10T10:30:00.000Z";
    const res = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-UTR-001",
        amount: 500,
        entryAt: explicitEntryAt,
      });

    expect(res.status).toBe(201);
    const saved = await DepositModel.findById(res.body.data._id).lean();
    expect(saved?.entryAt?.toISOString()).toBe(explicitEntryAt);
  });

  it("defaults deposit entryAt near current time when omitted", async () => {
    const before = Date.now();
    const res = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-UTR-002",
        amount: 600,
      });
    const after = Date.now();

    expect(res.status).toBe(201);
    const saved = await DepositModel.findById(res.body.data._id).lean();
    const entryAtMs = saved?.entryAt ? new Date(saved.entryAt).getTime() : 0;
    expect(entryAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(entryAtMs).toBeLessThanOrEqual(after + 1000);
  });

  it("rejects invalid deposit entryAt", async () => {
    const res = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-UTR-003",
        amount: 700,
        entryAt: "invalid-date",
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("validation_error");
  });

  it("creates withdrawal with explicit backdated requestedAt", async () => {
    const explicitRequestedAt = "2026-04-11T11:45:00.000Z";
    const res = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "111122223333",
        accountHolderName: "Backdated Holder",
        bankName: "Backdated Bank",
        ifsc: "BKID0000456",
        amount: 1200,
        reverseBonus: 50,
        requestedAt: explicitRequestedAt,
      });

    expect(res.status).toBe(201);
    const saved = await WithdrawalModel.findById(res.body.data._id).lean();
    expect(saved?.requestedAt?.toISOString()).toBe(explicitRequestedAt);
  });

  it("defaults withdrawal requestedAt near current time when omitted", async () => {
    const before = Date.now();
    const res = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "444455556666",
        accountHolderName: "Backdated Holder 2",
        bankName: "Backdated Bank",
        ifsc: "BKID0000789",
        amount: 1300,
        reverseBonus: 100,
      });
    const after = Date.now();

    expect(res.status).toBe(201);
    const saved = await WithdrawalModel.findById(res.body.data._id).lean();
    const requestedAtMs = saved?.requestedAt ? new Date(saved.requestedAt).getTime() : 0;
    expect(requestedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(requestedAtMs).toBeLessThanOrEqual(after + 1000);
  });

  it("rejects invalid withdrawal requestedAt", async () => {
    const res = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "777788889999",
        accountHolderName: "Backdated Holder 3",
        bankName: "Backdated Bank",
        ifsc: "BKID0000111",
        amount: 1500,
        reverseBonus: 0,
        requestedAt: "not-a-datetime",
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("validation_error");
  });

  it("amends verified deposit with explicit backdated entryAt and keeps amendment system timestamps", async () => {
    const createRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-001",
        amount: 900,
      });
    expect(createRes.status).toBe(201);
    const depositId = String(createRes.body.data._id);

    const verifyRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/exchange-action`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        action: "approve",
        playerId,
        bonusAmount: 0,
      });
    expect(verifyRes.status).toBe(200);

    const explicitEntryAt = "2025-02-01T08:15:00.000Z";
    const before = Date.now();
    const amendRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-001",
        amount: 910,
        playerId,
        bonusAmount: 10,
        entryAt: explicitEntryAt,
        reasonId: depositAmendReasonId,
        remark: "test backdated amend",
      });
    const after = Date.now();

    expect(amendRes.status).toBe(200);
    const saved = await DepositModel.findById(depositId).lean();
    expect(saved?.entryAt?.toISOString()).toBe(explicitEntryAt);
    const lastAmendedAtMs = saved?.lastAmendedAt ? new Date(saved.lastAmendedAt).getTime() : 0;
    expect(lastAmendedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(lastAmendedAtMs).toBeLessThanOrEqual(after + 1000);
    const historyAtMs = saved?.amendmentHistory?.at(-1)?.at
      ? new Date(saved.amendmentHistory.at(-1)!.at).getTime()
      : 0;
    expect(historyAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(historyAtMs).toBeLessThanOrEqual(after + 1000);
  });

  it("amends approved withdrawal with explicit backdated requestedAt and keeps amendment system timestamps", async () => {
    const createRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "909090909090",
        accountHolderName: "Amend Withdrawal Holder",
        bankName: "Amend Withdrawal Bank",
        ifsc: "BKID0000999",
        amount: 800,
        reverseBonus: 0,
      });
    expect(createRes.status).toBe(201);
    const withdrawalId = String(createRes.body.data._id);

    const approveRes = await request(app)
      .patch(`/api/v1/withdrawal/${withdrawalId}/banker-payout`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-WDR-AMEND-001",
      });
    expect(approveRes.status).toBe(200);

    const explicitRequestedAt = "2025-03-05T14:40:00.000Z";
    const before = Date.now();
    const amendRes = await request(app)
      .post(`/api/v1/withdrawal/${withdrawalId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        amount: 850,
        reverseBonus: 10,
        payoutBankId: bankId,
        utr: "BD-WDR-AMEND-002",
        requestedAt: explicitRequestedAt,
        reasonId: withdrawalAmendReasonId,
        remark: "test backdated amend",
      });
    const after = Date.now();

    expect(amendRes.status).toBe(200);
    const saved = await WithdrawalModel.findById(withdrawalId).lean();
    expect(saved?.requestedAt?.toISOString()).toBe(explicitRequestedAt);
    const lastAmendedAtMs = saved?.lastAmendedAt ? new Date(saved.lastAmendedAt).getTime() : 0;
    expect(lastAmendedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(lastAmendedAtMs).toBeLessThanOrEqual(after + 1000);
    const historyAtMs = saved?.amendmentHistory?.at(-1)?.at
      ? new Date(saved.amendmentHistory.at(-1)!.at).getTime()
      : 0;
    expect(historyAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(historyAtMs).toBeLessThanOrEqual(after + 1000);
  });

  it("amends approved withdrawal to amount zero (bank refund scenario)", async () => {
    const createRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "808080808080",
        accountHolderName: "Zero Amend Withdrawal Holder",
        bankName: "Zero Amend Withdrawal Bank",
        ifsc: "BKID0000888",
        amount: 1000,
        reverseBonus: 0,
      });
    expect(createRes.status).toBe(201);
    const withdrawalId = String(createRes.body.data._id);

    const approveRes = await request(app)
      .patch(`/api/v1/withdrawal/${withdrawalId}/banker-payout`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-WDR-AMEND-ZERO-001",
      });
    expect(approveRes.status).toBe(200);

    const bankAfterApprove = await BankModel.findById(bankId).lean();
    const balanceAfterApprove = Number(bankAfterApprove?.currentBalance ?? 0);

    const amendRes = await request(app)
      .post(`/api/v1/withdrawal/${withdrawalId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        amount: 0,
        reverseBonus: 0,
        payoutBankId: bankId,
        utr: "BD-WDR-AMEND-ZERO-002",
        reasonId: withdrawalAmendReasonId,
        remark: "bank transaction refunded",
      });
    expect(amendRes.status).toBe(200);

    const saved = await WithdrawalModel.findById(withdrawalId).lean();
    expect(saved?.amount).toBe(0);
    expect(saved?.payableAmount).toBe(0);

    const bankAfterAmend = await BankModel.findById(bankId).lean();
    expect(Number(bankAfterAmend?.currentBalance ?? 0)).toBe(balanceAfterApprove + 1000);
  });

  it("amends verified deposit to amount zero (bank refund scenario)", async () => {
    const createRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-ZERO-001",
        amount: 1000,
      });
    expect(createRes.status).toBe(201);
    const depositId = String(createRes.body.data._id);

    const verifyRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/exchange-action`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        action: "approve",
        playerId,
        bonusAmount: 0,
      });
    expect(verifyRes.status).toBe(200);

    const bankAfterVerify = await BankModel.findById(bankId).lean();
    const balanceAfterVerify = Number(bankAfterVerify?.currentBalance ?? 0);

    const amendRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-ZERO-002",
        amount: 0,
        playerId,
        bonusAmount: 0,
        reasonId: depositAmendReasonId,
        remark: "bank transaction refunded",
      });
    expect(amendRes.status).toBe(200);

    const saved = await DepositModel.findById(depositId).lean();
    expect(saved?.amount).toBe(0);
    expect(saved?.totalAmount).toBe(0);

    const bankAfterAmend = await BankModel.findById(bankId).lean();
    expect(Number(bankAfterAmend?.currentBalance ?? 0)).toBe(balanceAfterVerify - 1000);
  });

  it("rejects invalid amendment datetime for deposit and withdrawal", async () => {
    const depositCreateRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-INVALID",
        amount: 910,
      });
    const depositId = String(depositCreateRes.body.data._id);
    await request(app)
      .post(`/api/v1/deposit/${depositId}/exchange-action`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        action: "approve",
        playerId,
        bonusAmount: 0,
      });

    const depositAmendRes = await request(app)
      .post(`/api/v1/deposit/${depositId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-DEP-AMEND-INVALID",
        amount: 910,
        playerId,
        bonusAmount: 0,
        entryAt: "invalid-date",
        reasonId: depositAmendReasonId,
      });
    expect(depositAmendRes.status).toBe(400);
    expect(depositAmendRes.body.error?.code).toBe("validation_error");

    const withdrawalCreateRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "565656565656",
        accountHolderName: "Invalid Amend Holder",
        bankName: "Invalid Amend Bank",
        ifsc: "BKID0000565",
        amount: 700,
        reverseBonus: 0,
      });
    const withdrawalId = String(withdrawalCreateRes.body.data._id);
    await request(app)
      .patch(`/api/v1/withdrawal/${withdrawalId}/banker-payout`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        bankId,
        utr: "BD-WDR-AMEND-INVALID",
      });

    const withdrawalAmendRes = await request(app)
      .post(`/api/v1/withdrawal/${withdrawalId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        amount: 700,
        reverseBonus: 0,
        payoutBankId: bankId,
        utr: "BD-WDR-AMEND-INVALID-2",
        requestedAt: "invalid-date",
        reasonId: withdrawalAmendReasonId,
      });
    expect(withdrawalAmendRes.status).toBe(400);
    expect(withdrawalAmendRes.body.error?.code).toBe("validation_error");
  });

  it("filters deposit final list by entryAt (fallback from createdAt params)", async () => {
    const keepEntryAt = "2025-01-10T10:00:00.000Z";
    const skipEntryAt = "2025-01-11T10:00:00.000Z";
    const outsideCreatedAt = new Date("2026-01-01T00:00:00.000Z");

    const keepRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bankId, utr: "BD-DEP-FILTER-KEEP", amount: 300, entryAt: keepEntryAt });
    const skipRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bankId, utr: "BD-DEP-FILTER-SKIP", amount: 350, entryAt: skipEntryAt });

    expect(keepRes.status).toBe(201);
    expect(skipRes.status).toBe(201);

    await DepositModel.updateOne({ _id: keepRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });
    await DepositModel.updateOne({ _id: skipRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });

    const listRes = await request(app)
      .get("/api/v1/deposit")
      .query({
        view: "final",
        createdAt_from: "2025-01-10",
        createdAt_to: "2025-01-10",
        createdAt_op: "inRange",
        page: 1,
        pageSize: 200,
      })
      .set("Authorization", `Bearer ${accessToken}`);

    expect(listRes.status).toBe(200);
    const utrs = (listRes.body.data as Array<{ utr?: string }>).map((r) => r.utr);
    expect(utrs).toContain("BD-DEP-FILTER-KEEP");
    expect(utrs).not.toContain("BD-DEP-FILTER-SKIP");
  });

  it("filters withdrawal final list by requestedAt (fallback from createdAt params)", async () => {
    const keepRequestedAt = "2025-02-10T12:00:00.000Z";
    const skipRequestedAt = "2025-02-11T12:00:00.000Z";
    const outsideCreatedAt = new Date("2026-02-01T00:00:00.000Z");

    const keepRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "121212121212",
        accountHolderName: "Filter Keep",
        bankName: "Filter Bank",
        ifsc: "BKID0012121",
        amount: 500,
        reverseBonus: 0,
        requestedAt: keepRequestedAt,
      });
    const skipRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "343434343434",
        accountHolderName: "Filter Skip",
        bankName: "Filter Bank",
        ifsc: "BKID0034343",
        amount: 550,
        reverseBonus: 0,
        requestedAt: skipRequestedAt,
      });

    expect(keepRes.status).toBe(201);
    expect(skipRes.status).toBe(201);

    await WithdrawalModel.updateOne({ _id: keepRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });
    await WithdrawalModel.updateOne({ _id: skipRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });

    const listRes = await request(app)
      .get("/api/v1/withdrawal")
      .query({
        view: "final",
        createdAt_from: "2025-02-10",
        createdAt_to: "2025-02-10",
        createdAt_op: "inRange",
        page: 1,
        pageSize: 200,
      })
      .set("Authorization", `Bearer ${accessToken}`);

    expect(listRes.status).toBe(200);
    const accountNumbers = (listRes.body.data as Array<{ accountNumber?: string }>).map((r) => r.accountNumber);
    expect(accountNumbers).toContain("121212121212");
    expect(accountNumbers).not.toContain("343434343434");
  });

  it("uses business datetime for dashboard trend and recent activity", async () => {
    const trendDate = "2025-03-15";
    const depositEntryAt = "2025-03-15T09:00:00.000Z";
    const withdrawalRequestedAt = "2025-03-15T10:00:00.000Z";
    const outsideCreatedAt = new Date("2026-03-01T00:00:00.000Z");

    const depositRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ bankId, utr: "BD-DEP-DASH-001", amount: 410, entryAt: depositEntryAt });
    const withdrawalRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "565656565656",
        accountHolderName: "Dash Holder",
        bankName: "Dash Bank",
        ifsc: "BKID0056565",
        amount: 420,
        reverseBonus: 20,
        requestedAt: withdrawalRequestedAt,
      });

    expect(depositRes.status).toBe(201);
    expect(withdrawalRes.status).toBe(201);

    await DepositModel.updateOne({ _id: depositRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });
    await WithdrawalModel.updateOne({ _id: withdrawalRes.body.data._id }, { $set: { createdAt: outsideCreatedAt } });

    const dashboardRes = await request(app)
      .get("/api/v1/reports/dashboard-summary")
      .query({ fromDate: trendDate, toDate: trendDate })
      .set("Authorization", `Bearer ${accessToken}`);

    expect(dashboardRes.status).toBe(200);
    const trendRow = (dashboardRes.body.data.trendData as Array<{ date: string; depositCount: number; withdrawalCount: number }>)
      .find((row) => row.date === trendDate);
    expect(trendRow).toBeDefined();
    expect((trendRow?.depositCount ?? 0) >= 1).toBe(true);
    expect((trendRow?.withdrawalCount ?? 0) >= 1).toBe(true);

    const recentActivity = dashboardRes.body.data.recentActivity as Array<{ type: string; createdAt: string }>;
    const hasDepositByBusinessTime = recentActivity.some(
      (row) => row.type === "deposit" && new Date(row.createdAt).getTime() === new Date(depositEntryAt).getTime(),
    );
    const hasWithdrawalByBusinessTime = recentActivity.some(
      (row) => row.type === "withdrawal" && new Date(row.createdAt).getTime() === new Date(withdrawalRequestedAt).getTime(),
    );
    expect(hasDepositByBusinessTime).toBe(true);
    expect(hasWithdrawalByBusinessTime).toBe(true);
  });
});
