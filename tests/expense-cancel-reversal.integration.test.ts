import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { signAccessToken } from "../src/shared/utils/jwt";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExpenseModel } from "../src/modules/expense/expense.model";
import { ExpenseTypeModel } from "../src/modules/masters/expense-type.model";
import { LiabilityPersonModel } from "../src/modules/liability/liability-person.model";
import { LiabilityEntryModel } from "../src/modules/liability/liability-entry.model";
import { ReasonModel } from "../src/modules/masters/reason.model";
import { AuditLogModel } from "../src/modules/audit/audit.model";
import { REASON_TYPES } from "../src/shared/constants/reasonTypes";

describe("Superadmin cancel approved expense with reversal", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let superadminToken = "";
  let subAdminToken = "";
  let actorId = "";
  let bankId = "";
  let liablePersonId = "";
  let expenseTypeId = "";
  let cancelReasonId = "";

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
      fullName: "Expense Cancel Test SubAdmin",
      email: "expense.cancel.subadmin@example.com",
      username: "expense_cancel_subadmin",
      passwordHash: "not-used",
      role: "sub_admin",
      status: "active",
      permissions: ["expense.audit"],
      timezone: "Asia/Kolkata",
      createdBy: actor!._id,
    });
    subAdminToken = signAccessToken({
      userId: String(subAdmin._id),
      role: "sub_admin",
      permissions: ["expense.audit"],
      timezone: "Asia/Kolkata",
    });

    const bank = await BankModel.create({
      holderName: "Expense Cancel Bank",
      bankName: "EC Bank",
      accountNumber: "777766665555",
      ifsc: "ECBK0000777",
      openingBalance: 5000,
      currentBalance: 5000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);

    const liable = await LiabilityPersonModel.create({
      name: "Expense Cancel Liable",
      isActive: true,
      openingBalance: 0,
      totalDebits: 0,
      totalCredits: 0,
      closingBalance: 0,
      createdBy: actorId,
    });
    liablePersonId = String(liable._id);

    const et = await ExpenseTypeModel.create({
      name: "Audit Required Expense",
      code: "EC-AUDIT",
      auditRequired: true,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
    expenseTypeId = String(et._id);

    const reason = await ReasonModel.findOne({
      reasonType: REASON_TYPES.EXPENSE_CANCEL,
      reason: "Approved in error",
      deletedAt: null,
    }).lean();
    cancelReasonId = String(reason!._id);
  });

  beforeEach(async () => {
    await Promise.all([
      ExpenseModel.deleteMany({}),
      LiabilityEntryModel.deleteMany({}),
      AuditLogModel.deleteMany({}),
    ]);
    await BankModel.updateOne({ _id: bankId }, { $set: { currentBalance: 5000 } });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  const expenseDate = "2026-05-19";

  it("lists expense_cancel reason options for superadmin", async () => {
    const res = await request(app)
      .get("/api/v1/reasons/options")
      .query({ reasonType: REASON_TYPES.EXPENSE_CANCEL, limit: 200 })
      .set("Authorization", `Bearer ${superadminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const options = res.body.data;
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThanOrEqual(1);
    const reasons = options.map((o: { reason?: string }) => String(o.reason ?? ""));
    expect(reasons).toContain("Approved in error");
  });

  async function createPendingExpense() {
    const res = await request(app)
      .post("/api/v1/expense")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        expenseTypeId,
        amount: 250,
        expenseDate,
        description: "Cancel test expense",
        bankId,
      });
    expect(res.status).toBe(201);
    return String(res.body.data._id);
  }

  it("forbids non-superadmin from cancelling approved expense", async () => {
    const expenseId = await createPendingExpense();

    const approveRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/approve`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ settlementAccountType: "bank", bankId });
    expect(approveRes.status).toBe(200);

    const cancelRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/cancel`)
      .set("Authorization", `Bearer ${subAdminToken}`)
      .send({ reasonId: cancelReasonId });
    expect(cancelRes.status).toBe(403);
  });

  it("rejects cancel when expense is not approved", async () => {
    const expenseId = await createPendingExpense();

    const cancelRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/cancel`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ reasonId: cancelReasonId });
    expect(cancelRes.status).toBe(400);
  });

  it("cancels bank-settled approved expense and restores bank balance", async () => {
    const expenseId = await createPendingExpense();

    const approveRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/approve`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ settlementAccountType: "bank", bankId });
    expect(approveRes.status).toBe(200);

    const bankAfterApprove = await BankModel.findById(bankId).lean();
    expect(Number(bankAfterApprove?.currentBalance)).toBe(4750);

    const cancelRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/cancel`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ reasonId: cancelReasonId, remark: "Wrong approval" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("cancelled");

    const expense = await ExpenseModel.findById(expenseId).lean();
    expect(expense?.status).toBe("cancelled");
    expect(expense?.cancelReason).toContain("Approved in error");
    expect(expense?.liabilityEntryId).toBeFalsy();

    const bankAfterCancel = await BankModel.findById(bankId).lean();
    expect(Number(bankAfterCancel?.currentBalance)).toBe(5000);

    const audit = await AuditLogModel.findOne({ action: "expense.cancel", entityId: expenseId }).lean();
    expect(audit).toBeTruthy();
  });

  it("cancels person-settled approved expense and removes liability entry", async () => {
    const expenseId = await createPendingExpense();

    const approveRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/approve`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ settlementAccountType: "person", liabilityPersonId: liablePersonId });
    expect(approveRes.status).toBe(200);

    const expenseAfterApprove = await ExpenseModel.findById(expenseId).lean();
    const liabilityEntryId = String(expenseAfterApprove?.liabilityEntryId);
    expect(liabilityEntryId).toBeTruthy();

    const entryBefore = await LiabilityEntryModel.findById(liabilityEntryId).lean();
    expect(entryBefore).toBeTruthy();

    const cancelRes = await request(app)
      .post(`/api/v1/expense/${expenseId}/cancel`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({ reasonId: cancelReasonId });
    expect(cancelRes.status).toBe(200);

    const expense = await ExpenseModel.findById(expenseId).lean();
    expect(expense?.status).toBe("cancelled");
    expect(expense?.liabilityEntryId).toBeFalsy();

    const entryAfter = await LiabilityEntryModel.findById(liabilityEntryId).lean();
    expect(entryAfter).toBeNull();
  });
});
