import request from "supertest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExpenseTypeModel } from "../src/modules/masters/expense-type.model";
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { LiabilityEntryModel } from "../src/modules/liability/liability-entry.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { ExpenseModel } from "../src/modules/expense/expense.model";
import { createLiabilityEntry } from "../src/modules/liability/liability.service";
import {
  getBankAvailableBalance,
  syncBankCurrentBalancesFromLedger,
} from "../src/modules/bank/bankClosingBalance";
import { PlatformSettingsModel } from "../src/modules/settings/settings.model";

/**
 * Reproduces: Method Account Statement closing includes liability journal credits,
 * but expense used to gate on stale Bank.currentBalance (often 0).
 */
describe("Expense bank balance vs ledger closing", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let bankId = "";
  let personId = "";
  let skipAuditTypeId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    await PlatformSettingsModel.findOneAndUpdate(
      {},
      { $set: { platformCurrency: "USD" } },
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
      holderName: "Ledger Crypto QA",
      bankName: "Crypto",
      accountNumber: "CRYPTO-QA-EXP-BAL",
      ifsc: "CRYPTO0001",
      openingBalance: 0,
      currentBalance: 0,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const person = await LiabilityPersonModel.create({
      name: "HIREN Crypto QA",
      isActive: true,
      openingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      closingBalance: 0,
      createdBy: actorId,
    });
    personId = String(person._id);

    const et = await ExpenseTypeModel.create({
      name: "Forex Traders Expo QA",
      code: "FX-EXPO-QA",
      auditRequired: false,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
    skipAuditTypeId = String(et._id);
  });

  beforeEach(async () => {
    await Promise.all([
      LiabilityEntryModel.deleteMany({}),
      WithdrawalModel.deleteMany({}),
      ExpenseModel.deleteMany({}),
    ]);
    await BankModel.updateOne({ _id: bankId }, { $set: { currentBalance: 0, openingBalance: 0 } });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function seedStaleLedgerState() {
    // Insert liability credits without going through createLiabilityEntry sync —
    // mirrors historical drift where journals hit the statement but not currentBalance.
    await LiabilityEntryModel.create([
      {
        entryDate: new Date("2026-11-06T08:00:00.000Z"),
        entryType: "journal",
        amount: 2183,
        operatedCurrency: "USD",
        operatedAmount: 2183,
        exchangeRate: 1,
        fromAccountType: "person",
        fromAccountId: new Types.ObjectId(personId),
        toAccountType: "bank",
        toAccountId: new Types.ObjectId(bankId),
        remark: "QA-EXP-BAL liability 2183",
        createdBy: new Types.ObjectId(actorId),
      },
      {
        entryDate: new Date("2026-11-06T08:00:00.000Z"),
        entryType: "journal",
        amount: 10_000,
        operatedCurrency: "USD",
        operatedAmount: 10_000,
        exchangeRate: 1,
        fromAccountType: "person",
        fromAccountId: new Types.ObjectId(personId),
        toAccountType: "bank",
        toAccountId: new Types.ObjectId(bankId),
        remark: "QA-EXP-BAL liability 10000",
        createdBy: new Types.ObjectId(actorId),
      },
    ]);

    await WithdrawalModel.create({
      playerName: "QA Player",
      accountNumber: "4994142",
      accountHolderName: "QA",
      bankName: "External",
      ifsc: "XXXX0000000",
      amount: 5400,
      reverseBonus: 0,
      payableAmount: 5400,
      payoutSettlementType: "bank",
      payoutBankId: new Types.ObjectId(bankId),
      payoutBankName: "Crypto",
      utr: "QA-EXP-BAL-WD",
      status: "approved",
      requestedAt: new Date("2026-11-07T10:02:43.000Z"),
      createdBy: new Types.ObjectId(actorId),
    });
  }

  it("statement closing is 6783 while currentBalance stays stale at 0", async () => {
    await seedStaleLedgerState();

    const available = await getBankAvailableBalance(bankId);
    expect(available).toBe(6783);

    const bank = await BankModel.findById(bankId).lean();
    expect(Number(bank?.currentBalance ?? 0)).toBe(0);
  });

  it("allows 6500 skip-audit expense when ledger closing covers it despite stale currentBalance", async () => {
    await seedStaleLedgerState();

    const res = await request(app)
      .post("/api/v1/expense")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        expenseTypeId: skipAuditTypeId,
        amount: 6500,
        expenseDate: "2026-11-06",
        description: "QA-EXP-BAL expo",
        bankId,
        operatedCurrency: "USD",
        operatedAmount: 6500,
        exchangeRate: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("approved");
    expect(res.body.data.bankBalanceAfter).toBe(283);

    const bank = await BankModel.findById(bankId).lean();
    expect(Number(bank?.currentBalance ?? 0)).toBe(283);
    expect(await getBankAvailableBalance(bankId)).toBe(283);
  });

  it("rejects expense above ledger closing even if currentBalance were high", async () => {
    await seedStaleLedgerState();
    await BankModel.updateOne({ _id: bankId }, { $set: { currentBalance: 100_000 } });

    const res = await request(app)
      .post("/api/v1/expense")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        expenseTypeId: skipAuditTypeId,
        amount: 7000,
        expenseDate: "2026-11-06",
        description: "QA-EXP-BAL over",
        bankId,
        operatedCurrency: "USD",
        operatedAmount: 7000,
        exchangeRate: 1,
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("business_rule_error");
    expect(String(res.body.error?.message ?? "")).toMatch(/Insufficient bank balance/i);
  });

  it("createLiabilityEntry syncs Bank.currentBalance for bank credit legs", async () => {
    await createLiabilityEntry(
      {
        entryDate: "2026-11-06",
        entryType: "journal",
        amount: 2183,
        fromAccountType: "person",
        fromAccountId: personId,
        toAccountType: "bank",
        toAccountId: bankId,
        remark: "QA-EXP-BAL sync path",
        operatedCurrency: "USD",
        operatedAmount: 2183,
        exchangeRate: 1,
      },
      actorId,
    );

    const bank = await BankModel.findById(bankId).lean();
    expect(Number(bank?.currentBalance ?? 0)).toBe(2183);
    expect(await getBankAvailableBalance(bankId)).toBe(2183);
  });

  it("syncBankCurrentBalancesFromLedger repairs stale cache", async () => {
    await seedStaleLedgerState();
    await syncBankCurrentBalancesFromLedger([bankId]);
    const bank = await BankModel.findById(bankId).lean();
    expect(Number(bank?.currentBalance ?? 0)).toBe(6783);
  });
});
