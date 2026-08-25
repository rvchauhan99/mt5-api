import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { signAccessToken } from "../src/shared/utils/jwt";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { BankBalanceSettlementModel } from "../src/modules/bank/bank-balance-settlement.model";
import { PERMISSIONS } from "../src/shared/constants/permissions";

describe("Bank master settlement integration", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let superadminToken = "";
  let actorId = "";
  let subAdminNoPermsToken = "";
  let subAdminStatementToken = "";

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

    const subNo = await UserModel.create({
      fullName: "Settlement Sub No Perms",
      email: "settle.sub.nop@example.com",
      username: "settle_sub_nop",
      passwordHash: "not-used",
      role: "sub_admin",
      status: "active",
      permissions: [],
      timezone: "Asia/Kolkata",
      createdBy: actor!._id,
    });
    subAdminNoPermsToken = signAccessToken({
      userId: String(subNo._id),
      role: "sub_admin",
      permissions: [],
      timezone: "Asia/Kolkata",
    });

    const subStmt = await UserModel.create({
      fullName: "Settlement Sub Statement",
      email: "settle.sub.stmt@example.com",
      username: "settle_sub_stmt",
      passwordHash: "not-used",
      role: "sub_admin",
      status: "active",
      permissions: [PERMISSIONS.BANK_STATEMENT, PERMISSIONS.BANK_LIST],
      timezone: "Asia/Kolkata",
      createdBy: actor!._id,
    });
    subAdminStatementToken = signAccessToken({
      userId: String(subStmt._id),
      role: "sub_admin",
      permissions: [PERMISSIONS.BANK_STATEMENT, PERMISSIONS.BANK_LIST],
      timezone: "Asia/Kolkata",
    });
  });

  beforeEach(async () => {
    await Promise.all([BankBalanceSettlementModel.deleteMany({}), BankModel.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function seedBank(opening = 10_000, current = 10_000) {
    const bank = await BankModel.create({
      holderName: "Settlement Holder",
      bankName: "Settlement Bank",
      accountNumber: "SETTLE-ACC-001",
      ifsc: "SBIN0001234",
      openingBalance: opening,
      currentBalance: current,
      status: "active",
      createdBy: actorId,
    });
    return bank;
  }

  it("returns computed closing before settlement", async () => {
    const bank = await seedBank();
    const res = await request(app)
      .get(`/api/v1/bank/${bank._id}/computed-closing`)
      .set("Authorization", `Bearer ${superadminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.systemClosingBalance).toBe(10_000);
  });

  it("forbids POST settlement for non-superadmin", async () => {
    const bank = await seedBank();
    const res = await request(app)
      .post(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${subAdminNoPermsToken}`)
      .send({
        effectiveAt: new Date().toISOString(),
        masterReportedBalance: 10_500,
        reason: "Passbook mismatch after reconciliation review",
      });
    expect(res.status).toBe(403);
  });

  it("rejects settlement when master equals system balance", async () => {
    const bank = await seedBank();
    const res = await request(app)
      .post(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        effectiveAt: new Date().toISOString(),
        masterReportedBalance: 10_000,
        reason: "No difference — should fail validation",
      });
    expect(res.status).toBe(400);
  });

  it("superadmin creates settlement, updates currentBalance, list and ledger reflect it", async () => {
    const bank = await seedBank();
    const postRes = await request(app)
      .post(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        effectiveAt: new Date().toISOString(),
        masterReportedBalance: 10_500,
        reason: "Bank passbook closing differs from ERP computed balance",
      });
    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.data.signedAmount).toBe(500);
    expect(postRes.body.data.masterReportedBalance).toBe(10_500);
    expect(postRes.body.data.systemBalanceBefore).toBe(10_000);

    const refreshed = await BankModel.findById(bank._id).lean();
    expect(Number(refreshed?.currentBalance)).toBe(10_500);

    const listRes = await request(app)
      .get("/api/v1/bank")
      .set("Authorization", `Bearer ${superadminToken}`)
      .query({ page: 1, pageSize: 50, accountNumber: "SETTLE-ACC-001", accountNumber_op: "equals" });
    expect(listRes.status).toBe(200);
    const row = (listRes.body.data as Record<string, unknown>[]).find(
      (r) => String(r._id ?? r.id) === String(bank._id),
    );
    expect(Number(row?.closingBalanceActual)).toBe(10_500);

    const ledgerRes = await request(app)
      .get(`/api/v1/bank/${bank._id}/ledger`)
      .set("Authorization", `Bearer ${superadminToken}`);
    expect(ledgerRes.status).toBe(200);
    const rows = ledgerRes.body.data.rows as { kind: string; label?: string }[];
    const settlementRow = rows.find((r) => r.kind === "settlement");
    expect(settlementRow).toBeDefined();
    expect(settlementRow?.label).toContain("Master balance settlement");

    const listSettle = await request(app)
      .get(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${subAdminStatementToken}`);
    expect(listSettle.status).toBe(200);
    expect(Array.isArray(listSettle.body.data)).toBe(true);
    expect(listSettle.body.data.length).toBe(1);
  });

  it("allows sub_admin with bank.statement to read computed closing but not POST", async () => {
    const bank = await seedBank();
    const getRes = await request(app)
      .get(`/api/v1/bank/${bank._id}/computed-closing`)
      .set("Authorization", `Bearer ${subAdminStatementToken}`);
    expect(getRes.status).toBe(200);

    const postRes = await request(app)
      .post(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${subAdminStatementToken}`)
      .send({
        effectiveAt: new Date().toISOString(),
        masterReportedBalance: 11_000,
        reason: "Should be forbidden for non-superadmin",
      });
    expect(postRes.status).toBe(403);
  });

  it("dashboard bank wise closing includes settlement in selected period", async () => {
    const bank = await seedBank(10_000, 10_000);
    const settleRes = await request(app)
      .post(`/api/v1/bank/${bank._id}/settlements`)
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        effectiveAt: new Date().toISOString(),
        masterReportedBalance: 10_500,
        reason: "Dashboard settlement alignment test",
      });
    expect(settleRes.status).toBe(201);

    const dash = await request(app)
      .get("/api/v1/reports/dashboard-summary")
      .query({ fromDate: "2020-01-01", toDate: "2099-12-31" })
      .set("Authorization", `Bearer ${superadminToken}`);

    expect(dash.status).toBe(200);
    const rows = dash.body.data.banksBreakdown as Array<{ bankId: string; closingBalance: number; entries: number }>;
    const row = rows.find((r) => r.bankId === String(bank._id));
    expect(row).toBeDefined();
    expect(row?.closingBalance).toBe(10_500);
    expect(row?.entries).toBeGreaterThanOrEqual(1);
  });
});
