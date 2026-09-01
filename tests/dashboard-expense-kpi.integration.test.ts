import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExpenseModel } from "../src/modules/expense/expense.model";
import { ExpenseTypeModel } from "../src/modules/masters/expense-type.model";

describe("Dashboard expense KPI cancelled exclusion", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let superadminToken = "";
  let actorId = "";
  let bankId = "";
  let expenseTypeId = "";

  const expenseDate = new Date("2026-08-06T12:00:00.000Z");
  const rangeFrom = "2026-08-01";
  const rangeTo = "2026-08-31";

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

    const bank = await BankModel.create({
      method: "bank_transfer",
      holderName: "Dashboard Expense Bank",
      bankName: "Dashboard Expense Bank",
      accountNumber: "DASH-EXP-BANK-001",
      ifsc: "DASH0000001",
      openingBalance: 10_000,
      currentBalance: 10_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const expenseType = await ExpenseTypeModel.create({
      name: "Dashboard KPI Expense",
      code: "DASH-KPI-EXP",
      auditRequired: false,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
    expenseTypeId = String(expenseType._id);
  });

  beforeEach(async () => {
    await ExpenseModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("excludes cancelled and rejected expenses from dashboard KPI and bank summary", async () => {
    await ExpenseModel.create([
      {
        expenseTypeId,
        amount: 100,
        expenseDate,
        description: "Approved dashboard expense",
        bankId,
        bankName: "Dashboard Expense Bank",
        settlementAccountType: "bank",
        status: "approved",
        approvedBy: actorId,
        approvedAt: expenseDate,
        documents: [],
        createdBy: actorId,
        updatedBy: actorId,
      },
      {
        expenseTypeId,
        amount: 50,
        expenseDate,
        description: "Cancelled dashboard expense",
        bankId,
        bankName: "Dashboard Expense Bank",
        settlementAccountType: "bank",
        status: "cancelled",
        cancelledBy: actorId,
        cancelledAt: expenseDate,
        documents: [],
        createdBy: actorId,
        updatedBy: actorId,
      },
      {
        expenseTypeId,
        amount: 25,
        expenseDate,
        description: "Rejected dashboard expense",
        bankId,
        bankName: "Dashboard Expense Bank",
        settlementAccountType: "bank",
        status: "rejected",
        rejectReason: "Rejected for dashboard KPI test",
        documents: [],
        createdBy: actorId,
        updatedBy: actorId,
      },
    ]);

    const dashRes = await request(app)
      .get("/api/v1/reports/dashboard-summary")
      .query({ fromDate: rangeFrom, toDate: rangeTo })
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.expense.totalAmount).toBe(100);
    expect(dashRes.body.data.expense.totalCount).toBe(1);
    expect(dashRes.body.data.expense.approvedAmount).toBe(100);

    const bankRow = (dashRes.body.data.banksBreakdown as Array<{ bankId: string; expenses: number; expenseCount: number }>).find(
      (row) => row.bankId === bankId,
    );
    expect(bankRow).toBeDefined();
    expect(bankRow?.expenses).toBe(100);
    expect(bankRow?.expenseCount).toBe(1);
  });
});
