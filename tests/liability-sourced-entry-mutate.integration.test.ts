import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { LiabilityEntryModel } from "../src/modules/liability/liability-entry.model";
import { PlatformSettingsModel } from "../src/modules/settings/settings.model";
import { createLiabilityEntry } from "../src/modules/liability/liability.service";

describe("Liability sourced entry amend and delete", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let personId = "";
  let depositId = "";
  let entryId = "";

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
      holderName: "Sourced Edit Bank",
      bankName: "SE Bank",
      accountNumber: "777777777771",
      ifsc: "SEBK0000777",
      openingBalance: 10_000,
      currentBalance: 10_000,
      status: "active",
      createdBy: actorId,
    });

    const exchange = await ExchangeModel.create({
      name: "Sourced Edit Exchange",
      provider: "SE Provider",
      openingBalance: 5_000,
      currentBalance: 5_000,
      bonus: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });

    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "SOURCED-EDIT-PLAYER",
      phone: "9100000088",
      regularBonusPercentage: 0,
      firstDepositBonusPercentage: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const person = await LiabilityPersonModel.create({
      name: "Sourced Edit Person",
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
      bankName: "SE Bank",
      utr: "SOURCED-EDIT-DEP",
      amount: 1_000,
      bonusAmount: 0,
      totalAmount: 1_000,
      status: "verified",
      settlementAccountType: "person",
      liabilityPersonId: person._id,
      createdBy: actorId,
    });
    depositId = String(deposit._id);

    const entry = await createLiabilityEntry(
      {
        entryDate: "2026-03-01",
        entryType: "journal",
        amount: 1_000,
        fromAccountType: "deposit",
        fromAccountId: depositId,
        toAccountType: "person",
        toAccountId: personId,
        sourceType: "deposit",
        sourceDepositId: depositId,
        remark: "sourced edit test",
        operatedCurrency: "INR",
        operatedAmount: 1_000,
        exchangeRate: 1,
      },
      actorId,
    );
    entryId = String(entry._id);
    deposit.liabilityEntryId = entry._id;
    await deposit.save();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("PATCH deposit-sourced entry updates amount, keeps legs, syncs deposit.amount", async () => {
    const patchRes = await request(app)
      .patch(`/api/v1/liability/entries/${entryId}`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        entryDate: "2026-03-02",
        amount: 1_200,
        operatedCurrency: "INR",
        operatedAmount: 1_200,
        exchangeRate: 1,
        remark: "amended amount",
      });

    expect(patchRes.status).toBe(200);

    const entry = await LiabilityEntryModel.findById(entryId).lean();
    expect(entry).toBeTruthy();
    expect(entry!.amount).toBe(1_200);
    expect(entry!.fromAccountType).toBe("deposit");
    expect(entry!.toAccountType).toBe("person");
    expect(String(entry!.fromAccountId)).toBe(depositId);
    expect(String(entry!.toAccountId)).toBe(personId);
    expect(entry!.sourceType).toBe("deposit");
    expect(entry!.remark).toBe("amended amount");

    const deposit = await DepositModel.findById(depositId).lean();
    expect(deposit!.amount).toBe(1_200);
    expect(String(deposit!.liabilityEntryId)).toBe(entryId);

    const person = await LiabilityPersonModel.findById(personId).lean();
    expect(Number(person!.totalDebits)).toBe(1_200);
  });

  it("DELETE deposit-sourced entry clears deposit.liabilityEntryId and removes entry", async () => {
    const delRes = await request(app)
      .delete(`/api/v1/liability/entries/${entryId}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(delRes.status).toBe(200);

    const entry = await LiabilityEntryModel.findById(entryId).lean();
    expect(entry).toBeNull();

    const deposit = await DepositModel.findById(depositId).lean();
    expect(deposit!.liabilityEntryId).toBeFalsy();
    expect(deposit!.status).toBe("verified");

    const person = await LiabilityPersonModel.findById(personId).lean();
    expect(Number(person!.totalDebits)).toBe(0);
  });
});
