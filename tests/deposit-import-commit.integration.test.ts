import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { AuditLogModel } from "../src/modules/audit/audit.model";
import { applyDepositImportRows, commitDepositImportRows } from "../src/modules/deposit/deposit.service";

function flushBackgroundTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("deposit import bulk commit", () => {
  let mongo: MongoMemoryServer;
  let actorId = "";
  let bankId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);

    const bank = await BankModel.create({
      holderName: "Import Bulk Bank",
      bankName: "IB Bank",
      accountNumber: "888888888801",
      ifsc: "IBBK0000888",
      openingBalance: 100_000,
      currentBalance: 100_000,
      status: "active",
      createdBy: actorId,
    });
    bankId = String(bank._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await DepositModel.deleteMany({});
    await AuditLogModel.deleteMany({ action: "deposit.import" });
  });

  it("inserts 60 rows in chunks under 30 seconds", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      utr: `BULK-UTR-${String(i + 1).padStart(4, "0")}`,
      amount: 100 + i,
      settlementAccountType: "bank" as const,
      bankId,
    }));

    const started = Date.now();
    const result = await applyDepositImportRows(rows, actorId, { chunkSize: 25 });
    const elapsed = Date.now() - started;

    expect(result.created).toBe(60);
    expect(result.errors).toHaveLength(0);
    expect(elapsed).toBeLessThan(30_000);

    const count = await DepositModel.countDocuments({ bankId });
    expect(count).toBe(60);
  });

  it("records duplicate UTR errors while inserting other rows in the same chunk", async () => {
    await DepositModel.create({
      settlementAccountType: "bank",
      bankId: new mongoose.Types.ObjectId(bankId),
      bankName: "Existing",
      utr: "DUPLICATE-UTR-001",
      amount: 500,
      status: "pending",
      createdBy: new mongoose.Types.ObjectId(actorId),
      bankImpact: true,
    });

    const rows = [
      {
        utr: "DUPLICATE-UTR-001",
        amount: 100,
        settlementAccountType: "bank" as const,
        bankId,
      },
      {
        utr: "UNIQUE-UTR-002",
        amount: 200,
        settlementAccountType: "bank" as const,
        bankId,
      },
      {
        utr: "UNIQUE-UTR-003",
        amount: 300,
        settlementAccountType: "bank" as const,
        bankId,
      },
    ];

    const result = await applyDepositImportRows(rows, actorId, { chunkSize: 10 });

    expect(result.created).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.utr).toBe("DUPLICATE-UTR-001");
    expect(result.errors[0]?.error).toMatch(/UTR already exists/i);
  });

  it("commitDepositImportRows writes one summary audit in the background", async () => {
    const rows = [
      {
        utr: "AUDIT-UTR-001",
        amount: 111,
        settlementAccountType: "bank" as const,
        bankId,
      },
    ];

    await commitDepositImportRows(rows, actorId, "req-test-1");
    await flushBackgroundTasks();

    const audits = await AuditLogModel.find({ action: "deposit.import" }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.newValue).toMatchObject({
      created: 1,
      failed: 0,
      totalRows: 1,
    });
  });

  it("reports progress after each chunk", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      utr: `PROG-UTR-${i + 1}`,
      amount: 50,
      settlementAccountType: "bank" as const,
      bankId,
    }));

    const progressSnapshots: number[] = [];
    await applyDepositImportRows(rows, actorId, {
      chunkSize: 2,
      onProgress: async (p) => {
        progressSnapshots.push(p.processedRows);
      },
    });

    expect(progressSnapshots).toEqual([2, 4, 5]);
  });
});
