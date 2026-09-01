import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { AuditLogModel } from "../src/modules/audit/audit.model";
import { PlatformSettingsModel, PLATFORM_SETTINGS_KEY } from "../src/modules/settings/settings.model";

describe("Bank method upsert integration", () => {
  let mongo: MongoMemoryServer;
  const app = createApp();
  let superadminToken = "";
  let actorId = "";

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

    await PlatformSettingsModel.findOneAndUpdate(
      { key: PLATFORM_SETTINGS_KEY },
      {
        $set: {
          platformCurrency: "INR",
          currencyLockedAt: new Date(),
          currencyLockedBy: new mongoose.Types.ObjectId(actorId),
        },
      },
      { upsert: true },
    );
  });

  beforeEach(async () => {
    await Promise.all([BankModel.deleteMany({}), AuditLogModel.deleteMany({ entity: "bank" })]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  it("creates a bank on first POST for a payment method", async () => {
    const res = await request(app)
      .post("/api/v1/bank")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        method: "crypto",
        openingBalance: 5000,
        status: "active",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.meta).toEqual({ created: true });
    expect(res.body.data.method).toBe("crypto");
    expect(res.body.data.openingBalance).toBe(5000);
    expect(res.body.data.currentBalance).toBe(5000);

    const count = await BankModel.countDocuments({ method: "crypto" });
    expect(count).toBe(1);

    const audit = await AuditLogModel.findOne({ action: "bank.create", entity: "bank" }).lean();
    expect(audit).toBeTruthy();
  });

  it("updates existing bank when same payment method is posted again", async () => {
    const first = await request(app)
      .post("/api/v1/bank")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        method: "crypto",
        openingBalance: 5000,
        status: "active",
      });
    expect(first.status).toBe(201);
    const originalAccountNumber = first.body.data.accountNumber;
    const originalCurrentBalance = 12_500;

    await BankModel.updateOne(
      { _id: first.body.data._id },
      { $set: { currentBalance: originalCurrentBalance } },
    );

    const second = await request(app)
      .post("/api/v1/bank")
      .set("Authorization", `Bearer ${superadminToken}`)
      .send({
        method: "crypto",
        openingBalance: 8000,
        status: "deactive",
      });

    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.meta).toEqual({ created: false, updated: true });
    expect(String(second.body.data._id)).toBe(String(first.body.data._id));
    expect(second.body.data.openingBalance).toBe(8000);
    expect(second.body.data.status).toBe("deactive");
    expect(second.body.data.accountNumber).toBe(originalAccountNumber);
    expect(second.body.data.currentBalance).toBe(originalCurrentBalance);

    const count = await BankModel.countDocuments({ method: "crypto" });
    expect(count).toBe(1);

    const updateAudit = await AuditLogModel.findOne({ action: "bank.update", entity: "bank" }).lean();
    expect(updateAudit).toBeTruthy();
    expect(updateAudit?.oldValue).toMatchObject({ openingBalance: 5000, status: "active" });
    expect(updateAudit?.newValue).toMatchObject({ openingBalance: 8000, status: "deactive" });
  });
});
