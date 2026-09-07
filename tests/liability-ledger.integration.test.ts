import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { PlatformSettingsModel } from "../src/modules/settings/settings.model";
import { createLiabilityEntry } from "../src/modules/liability/liability.service";
import { PlayerModel } from "../src/modules/player/player.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";

describe("Liability person ledger period and view modes", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let bankId = "";
  let personId = "";
  let depositId = "";
  let withdrawalId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    await PlatformSettingsModel.findOneAndUpdate(
      {},
      { $set: { platformCurrency: "INR" } },
      { upsert: true },
    );

    const loginRes = await request(app).post("/api/v1/auth/login").send({
      username: "superadmin",
      password: "SuperAdmin@123",
    });
    accessToken = loginRes.body.data.accessToken;

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const bank = await BankModel.create({
      holderName: "Ledger Test Bank",
      bankName: "LT Bank",
      accountNumber: "888888888881",
      ifsc: "LTBK0000888",
      openingBalance: 20_000,
      currentBalance: 20_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const exchange = await ExchangeModel.create({
      name: "Ledger Test Exchange",
      provider: "Ledger Provider",
      openingBalance: 5_000,
      currentBalance: 5_000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "LEDGER-PLAYER-1",
      phone: "9100000099",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const person = await LiabilityPersonModel.create({
      name: "Ledger Test Person",
      isActive: true,
      openingBalance: 5_000,
      totalDebits: 0,
      totalCredits: 0,
      closingBalance: 5_000,
      createdBy: actorId,
    });
    personId = String(person._id);

    const deposit = await DepositModel.create({
      player: player._id,
      bankId: bank._id,
      bankName: "LT Bank",
      utr: "LEDGER-DEP-1000",
      amount: 1_000,
      bonusAmount: 0,
      totalAmount: 1_000,
      status: "verified",
      settlementAccountType: "person",
      liabilityPersonId: person._id,
      createdBy: actorId,
    });
    depositId = String(deposit._id);

    const withdrawal = await WithdrawalModel.create({
      player: player._id,
      playerName: "Ledger Player",
      accountNumber: "1111222233334444",
      accountHolderName: "Player Beneficiary",
      bankName: "Player Ext Bank",
      ifsc: "PYTM0005555",
      amount: 1_000,
      reverseBonus: 0,
      payableAmount: 1_000,
      status: "finalized",
      createdBy: actorId,
    });
    withdrawalId = String(withdrawal._id);

    await createLiabilityEntry(
      {
        entryDate: "2026-01-10",
        entryType: "journal",
        amount: 1_000,
        fromAccountType: "deposit",
        fromAccountId: depositId,
        toAccountType: "person",
        toAccountId: personId,
        sourceType: "deposit",
        sourceDepositId: depositId,
        remark: "ledger test deposit",
        operatedCurrency: "INR",
        operatedAmount: 1_000,
        exchangeRate: 1,
      },
      actorId,
    );

    await createLiabilityEntry(
      {
        entryDate: "2026-02-15",
        entryType: "journal",
        amount: 1_000,
        fromAccountType: "person",
        fromAccountId: personId,
        toAccountType: "withdrawal",
        toAccountId: withdrawalId,
        sourceType: "withdrawal",
        sourceWithdrawalId: withdrawalId,
        remark: "ledger test withdrawal",
        operatedCurrency: "INR",
        operatedAmount: 1_000,
        exchangeRate: 1,
      },
      actorId,
    );

    await createLiabilityEntry(
      {
        entryDate: "2026-03-20",
        entryType: "receipt",
        amount: 250,
        fromAccountType: "bank",
        fromAccountId: bankId,
        toAccountType: "person",
        toAccountId: personId,
        remark: "ledger test manual receipt",
        operatedCurrency: "INR",
        operatedAmount: 250,
        exchangeRate: 1,
      },
      actorId,
    );
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("platform all-time ledger matches persons list closing and DR/CR", async () => {
    const listRes = await request(app)
      .get("/api/v1/liability/persons")
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ search: "Ledger Test Person", page: 1, pageSize: 10 });

    expect(listRes.status).toBe(200);
    const listRow = (listRes.body.data as Array<{
      _id: string;
      totalDebits: number;
      totalCredits: number;
      closingBalance: number;
      closingBalanceSide: string;
    }>).find((r) => String(r._id) === personId);
    expect(listRow).toBeTruthy();
    expect(listRow!.totalDebits).toBe(1_250);
    expect(listRow!.totalCredits).toBe(1_000);
    expect(listRow!.closingBalance).toBe(5_250);
    expect(listRow!.closingBalanceSide).toBe("receivable");

    const ledgerRes = await request(app)
      .get(`/api/v1/liability/persons/${personId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ viewMode: "platform" });

    expect(ledgerRes.status).toBe(200);
    const ledger = ledgerRes.body.data;
    expect(ledger.viewMode).toBe("platform");
    expect(ledger.periodOpeningBalance).toBe(5_000);
    expect(ledger.periodClosingBalance).toBe(5_250);
    expect(ledger.periodClosingSide).toBe("receivable");
    expect(ledger.closingBalance).toBe(5_250);

    const dr = (ledger.rows as Array<{ debit: number }>).reduce((a, r) => a + r.debit, 0);
    const cr = (ledger.rows as Array<{ credit: number }>).reduce((a, r) => a + r.credit, 0);
    expect(dr).toBe(1_250);
    expect(cr).toBe(1_000);

    const depositRow = (ledger.rows as Array<{ debit: number; credit: number }>).find(
      (r) => r.debit === 1_000 && r.credit === 0,
    );
    const withdrawalRow = (ledger.rows as Array<{ debit: number; credit: number }>).find(
      (r) => r.credit === 1_000 && r.debit === 0,
    );
    expect(depositRow).toBeTruthy();
    expect(withdrawalRow).toBeTruthy();
  });

  it("person (inverse) mode closing matches stored person rollup", async () => {
    const person = await LiabilityPersonModel.findById(personId).lean();
    expect(person).toBeTruthy();
    expect(Number(person!.closingBalance)).toBe(4_750);

    const ledgerRes = await request(app)
      .get(`/api/v1/liability/persons/${personId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ viewMode: "person" });

    expect(ledgerRes.status).toBe(200);
    const ledger = ledgerRes.body.data;
    expect(ledger.viewMode).toBe("person");
    expect(ledger.periodOpeningBalance).toBe(5_000);
    expect(ledger.periodClosingBalance).toBe(4_750);
    expect(ledger.periodClosingBalance).toBe(Number(person!.closingBalance));
  });

  it("period window returns mid-history open/close; empty window open equals close", async () => {
    const midRes = await request(app)
      .get(`/api/v1/liability/persons/${personId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ fromDate: "2026-02-01", toDate: "2026-02-28", viewMode: "platform" });

    expect(midRes.status).toBe(200);
    const mid = midRes.body.data;
    expect(mid.periodOpeningBalance).toBe(6_000);
    expect(mid.periodClosingBalance).toBe(5_000);
    expect(mid.rows).toHaveLength(1);
    expect(mid.rows[0].credit).toBe(1_000);
    expect(mid.closingBalance).toBe(5_250);

    const emptyRes = await request(app)
      .get(`/api/v1/liability/persons/${personId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`)
      .query({ fromDate: "2026-04-01", toDate: "2026-04-30", viewMode: "platform" });

    expect(emptyRes.status).toBe(200);
    const empty = emptyRes.body.data;
    expect(empty.rows).toHaveLength(0);
    expect(empty.periodOpeningBalance).toBe(5_250);
    expect(empty.periodClosingBalance).toBe(5_250);
    expect(empty.periodOpeningBalance).toBe(empty.periodClosingBalance);
    expect(empty.closingBalance).toBe(5_250);
  });
});
