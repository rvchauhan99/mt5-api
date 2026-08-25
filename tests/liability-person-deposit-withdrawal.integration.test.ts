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
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { LiabilityEntryModel } from "../src/modules/liability/liability-entry.model";
import { ReasonModel } from "../src/modules/masters/reason.model";
import { REASON_TYPES } from "../src/shared/constants/reasonTypes";

describe("Liability person deposit settlement and withdrawal payout", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let bankId = "";
  let playerId = "";
  let liablePersonId = "";

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
      holderName: "Settlement Test Bank",
      bankName: "ST Bank",
      accountNumber: "999999999991",
      ifsc: "STBK0000999",
      openingBalance: 50_000,
      currentBalance: 50_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const exchange = await ExchangeModel.create({
      name: "LP Test Exchange",
      provider: "LP Provider",
      openingBalance: 10_000,
      currentBalance: 10_000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "LP-PLAYER-1",
      phone: "9100000001",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerId = String(player._id);

    const liable = await LiabilityPersonModel.create({
      name: "Test Liable Person",
      isActive: true,
      openingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      closingBalance: 0,
      createdBy: actorId,
    });
    liablePersonId = String(liable._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("person-settled deposit: exchange approve skips bank balance and writes liability entry", async () => {
    const bankBefore = await BankModel.findById(bankId).select("currentBalance").lean();

    const createRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        settlementAccountType: "person",
        liabilityPersonId: liablePersonId,
        utr: "LP-DEP-UTR-1001",
        amount: 300,
      });

    expect(createRes.status).toBe(201);
    const depId = String(createRes.body.data._id);
    const pending = await DepositModel.findById(depId).lean();
    expect(pending?.settlementAccountType).toBe("person");
    expect(pending?.bankId).toBeUndefined();
    expect(String(pending?.liabilityPersonId)).toBe(liablePersonId);

    const approveRes = await request(app)
      .post(`/api/v1/deposit/${depId}/exchange-action`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        action: "approve",
        playerId,
        bonusAmount: 0,
      });
    expect(approveRes.status).toBe(200);

    const bankAfterSame = await BankModel.findById(bankId).select("currentBalance").lean();
    expect(Number(bankAfterSame?.currentBalance)).toBe(Number(bankBefore?.currentBalance));

    const verified = await DepositModel.findById(depId).lean();
    expect(verified?.status).toBe("verified");
    expect(verified?.liabilityEntryId).toBeDefined();

    const entry = await LiabilityEntryModel.findOne({ sourceDepositId: verified?._id }).lean();
    expect(entry).toBeTruthy();
    expect(entry?.sourceType).toBe("deposit");
    expect(String(entry?.toAccountId)).toBe(depId);
    expect(String(entry?.fromAccountId)).toBe(liablePersonId);
    expect(entry?.amount).toBe(300);
  });

  it("person-settled verified deposit can be amended without bankId; amount change refreshes liability entry", async () => {
    const amendReasonDoc = await ReasonModel.findOne({
      reasonType: REASON_TYPES.DEPOSIT_FINAL_AMEND,
      isActive: true,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .select("_id")
      .lean();
    expect(amendReasonDoc).toBeTruthy();

    const createRes = await request(app)
      .post("/api/v1/deposit")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        settlementAccountType: "person",
        liabilityPersonId: liablePersonId,
        utr: "LP-DEP-UTR-AMEND-5001",
        amount: 400,
      });
    expect(createRes.status).toBe(201);
    const depId = String(createRes.body.data._id);

    await request(app)
      .post(`/api/v1/deposit/${depId}/exchange-action`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        action: "approve",
        playerId,
        bonusAmount: 10,
      });

    const beforeAmend = await DepositModel.findById(depId).lean();
    const oldEntryId = String(beforeAmend?.liabilityEntryId ?? "");
    expect(oldEntryId).toBeTruthy();

    const amendRes = await request(app)
      .post(`/api/v1/deposit/${depId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        utr: "LP-DEP-UTR-AMEND-5001",
        amount: 350,
        playerId,
        bonusAmount: 20,
        reasonId: String(amendReasonDoc!._id),
      });

    expect(amendRes.status).toBe(200);

    const after = await DepositModel.findById(depId).lean();
    expect(after?.amount).toBe(350);
    expect(after?.bonusAmount).toBe(20);
    expect(after?.totalAmount).toBe(370);
    expect(String(after?.liabilityEntryId)).not.toBe(oldEntryId);

    const entries = await LiabilityEntryModel.find({ sourceDepositId: beforeAmend?._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(350);
    expect(entries[0]?.sourceType).toBe("deposit");
    expect(Number(after?.amendmentCount)).toBeGreaterThanOrEqual(1);
  });

  it("banker payout via liability person: no payout bank, liability entry tied to withdrawal", async () => {
    const wdRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "1111222233334444",
        accountHolderName: "Player Beneficiary",
        bankName: "Player Ext Bank",
        ifsc: "PYTM0005555",
        amount: 200,
        reverseBonus: 0,
      });

    expect(wdRes.status).toBe(201);
    const wId = String(wdRes.body.data._id);

    const payoutRes = await request(app)
      .patch(`/api/v1/withdrawal/${wId}/banker-payout`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        payoutSettlementType: "person",
        liabilityPersonId: liablePersonId,
        utr: "LP-WDR-UTR-2002",
      });

    expect(payoutRes.status).toBe(200);

    const w = await WithdrawalModel.findById(wId).lean();
    expect(w?.status).toBe("approved");
    expect(w?.payoutSettlementType).toBe("person");
    expect(w?.payoutBankId).toBeUndefined();
    expect(String(w?.payoutLiabilityPersonId)).toBe(liablePersonId);
    expect(w?.payoutLiabilityEntryId).toBeDefined();

    const entry = await LiabilityEntryModel.findOne({ sourceWithdrawalId: w?._id }).lean();
    expect(entry).toBeTruthy();
    expect(entry?.sourceType).toBe("withdrawal");
    expect(String(entry?.fromAccountId)).toBe(wId);
    expect(String(entry?.toAccountId)).toBe(liablePersonId);
  });

  it("person-settled withdrawal: amend without payoutBankId updates payable and liability entry", async () => {
    const amendReasonDoc = await ReasonModel.findOne({
      reasonType: REASON_TYPES.WITHDRAWAL_FINAL_AMEND,
      isActive: true,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .select("_id")
      .lean();
    expect(amendReasonDoc).toBeTruthy();

    const wdRes = await request(app)
      .post("/api/v1/withdrawal")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        playerId,
        accountNumber: "5555666677778888",
        accountHolderName: "WD Amend LP",
        bankName: "Beneficiary Bank",
        ifsc: "PYTM0006666",
        amount: 200,
        reverseBonus: 0,
      });
    expect(wdRes.status).toBe(201);
    const wId = String(wdRes.body.data._id);

    const payoutRes = await request(app)
      .patch(`/api/v1/withdrawal/${wId}/banker-payout`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        payoutSettlementType: "person",
        liabilityPersonId: liablePersonId,
        utr: "LP-WDR-AMEND-BASE-7701",
      });
    expect(payoutRes.status).toBe(200);

    const beforeAmend = await WithdrawalModel.findById(wId).lean();
    const oldEntryId = String(beforeAmend?.payoutLiabilityEntryId ?? "");
    expect(oldEntryId).toBeTruthy();
    expect(Number(beforeAmend?.payableAmount ?? 0)).toBe(200);

    const amendRes = await request(app)
      .post(`/api/v1/withdrawal/${wId}/amend`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        amount: 260,
        reverseBonus: 40,
        utr: "LP-WDR-AMEND-NEXT-7702",
        reasonId: String(amendReasonDoc!._id),
      });

    expect(amendRes.status).toBe(200);

    const after = await WithdrawalModel.findById(wId).lean();
    expect(after?.amount).toBe(260);
    expect(after?.reverseBonus).toBe(40);
    expect(Number(after?.payableAmount ?? 0)).toBe(220);
    expect(String(after?.payoutLiabilityEntryId)).not.toBe(oldEntryId);

    const entries = await LiabilityEntryModel.find({
      sourceWithdrawalId: beforeAmend?._id,
      sourceType: "withdrawal",
    }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(220);
    expect(String(entries[0]?.toAccountId)).toBe(liablePersonId);
  });

  it("GET /liability/persons returns platform-side closing on list rows", async () => {
    const person = await LiabilityPersonModel.findById(liablePersonId).lean();
    expect(person).toBeTruthy();
    const opening = Number(person!.openingBalance ?? 0);
    const debits = Number(person!.totalDebits ?? 0);
    const credits = Number(person!.totalCredits ?? 0);
    const platformClosing = opening + debits - credits;
    const personStoredClosing = Number(person!.closingBalance ?? 0);

    const listRes = await request(app)
      .get("/api/v1/liability/persons")
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ search: "Test Liable Person", page: 1, pageSize: 10 });

    expect(listRes.status).toBe(200);
    const rows = listRes.body.data as Array<{
      _id: string;
      closingBalance: number;
      closingBalanceAbs: number;
      closingBalanceSide: string;
    }>;
    const row = rows.find((r) => String(r._id) === liablePersonId);
    expect(row).toBeTruthy();
    expect(row!.closingBalance).toBe(platformClosing);
    expect(row!.closingBalanceAbs).toBe(Math.abs(platformClosing));
    const expectedSide =
      platformClosing === 0 ? "settled" : platformClosing > 0 ? "receivable" : "payable";
    expect(row!.closingBalanceSide).toBe(expectedSide);

    if (debits !== credits) {
      expect(row!.closingBalance).not.toBe(personStoredClosing);
    }
  });
});
