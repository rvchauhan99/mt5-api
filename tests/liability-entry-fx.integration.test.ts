import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { ExpenseTypeModel } from "../src/modules/masters/expense-type.model";
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { LiabilityEntryModel } from "../src/modules/liability/liability-entry.model";
import { PlatformSettingsModel } from "../src/modules/settings/settings.model";
import { createLiabilityEntry } from "../src/modules/liability/liability.service";

describe("Liability entry FX from person-settled sources", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let accessToken = "";
  let actorId = "";
  let expenseTypeId = "";
  let liablePersonId = "";
  let bankIdForManual = "";

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

    const et = await ExpenseTypeModel.create({
      name: "FX Ledger Expense",
      code: "FX-LEDGER",
      auditRequired: true,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
    expenseTypeId = String(et._id);

    const liable = await LiabilityPersonModel.create({
      name: "Hardik Bhai INR payment",
      isActive: true,
      openingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      closingBalance: 0,
      createdBy: actorId,
    });
    liablePersonId = String(liable._id);

    const bankRes = await request(app)
      .post("/api/v1/banks")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        holderName: "FX Ledger Bank",
        bankName: "FX Bank",
        accountNumber: "111122223333",
        ifsc: "FXBK0000111",
        openingBalance: 10000,
      });
    if (bankRes.status === 201) {
      bankIdForManual = String(bankRes.body.data._id);
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("copies expense operated FX onto liability entry and ledger breakdown", async () => {
    const createRes = await request(app)
      .post("/api/v1/expense")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        expenseTypeId,
        amount: 50000,
        expenseDate: "2026-08-11",
        description: "INR office expense",
        operatedCurrency: "INR",
        operatedAmount: 50000,
        exchangeRate: 0.01051606,
      });
    expect(createRes.status).toBe(201);
    const expenseId = String(createRes.body.data._id);
    expect(createRes.body.data.operatedCurrency).toBe("INR");
    expect(Number(createRes.body.data.operatedAmount)).toBe(50000);

    const approveRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/approve`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ settlementAccountType: "person", liabilityPersonId: liablePersonId });
    expect(approveRes.status).toBe(200);

    const entry = await LiabilityEntryModel.findOne({ sourceExpenseId: expenseId }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.operatedCurrency).toBe("INR");
    expect(Number(entry!.operatedAmount)).toBe(50000);
    expect(Number(entry!.exchangeRate)).toBeCloseTo(0.01051606, 6);
    expect(Number(entry!.amount)).toBe(Number(createRes.body.data.amount));

    const ledgerRes = await request(app)
      .get(`/api/v1/liability/persons/${liablePersonId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(ledgerRes.status).toBe(200);
    const rows = ledgerRes.body.data.rows as Array<{
      operatedCurrency?: string;
      operatedAmount?: number;
      exchangeRate?: number;
      credit: number;
    }>;
    const row = rows.find((r) => Number(r.credit) > 0 && r.operatedCurrency === "INR");
    expect(row).toBeTruthy();
    expect(Number(row!.operatedAmount)).toBe(50000);

    const breakdown = ledgerRes.body.data.operatedCurrencyBreakdown as Array<{
      currency: string;
      creditOperated: number;
      creditPlatform: number;
    }>;
    expect(Array.isArray(breakdown)).toBe(true);
    const inr = breakdown.find((b) => b.currency === "INR");
    expect(inr).toBeTruthy();
    expect(Number(inr!.creditOperated)).toBeGreaterThanOrEqual(50000);
  });

  it("includes manual liability entry FX in ledger breakdown", async () => {
    if (!bankIdForManual) {
      // Bank create may require different fields in some envs; create via model fallback.
      const { BankModel } = await import("../src/modules/bank/bank.model");
      const bank = await BankModel.create({
        holderName: "FX Manual Bank",
        bankName: "FXM Bank",
        accountNumber: "444455556666",
        ifsc: "FXMB0000444",
        openingBalance: 10000,
        currentBalance: 10000,
        status: "active",
        createdBy: actorId,
      });
      bankIdForManual = String(bank._id);
    }

    await createLiabilityEntry(
      {
        entryDate: "2026-08-12",
        entryType: "payment",
        amount: 100,
        fromAccountType: "person",
        fromAccountId: liablePersonId,
        toAccountType: "bank",
        toAccountId: bankIdForManual,
        operatedCurrency: "AED",
        operatedAmount: 367,
        exchangeRate: 0.27229407,
        preservePlatformAmount: true,
        remark: "Manual AED payment",
      },
      actorId,
    );

    const ledgerRes = await request(app)
      .get(`/api/v1/liability/persons/${liablePersonId}/ledger`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(ledgerRes.status).toBe(200);
    const breakdown = ledgerRes.body.data.operatedCurrencyBreakdown as Array<{ currency: string }>;
    const currencies = breakdown.map((b) => b.currency);
    expect(currencies).toEqual(expect.arrayContaining(["INR", "AED"]));
  });
});
