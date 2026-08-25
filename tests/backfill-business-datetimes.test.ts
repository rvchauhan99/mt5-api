import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { DepositModel } from "../src/modules/deposit/deposit.model";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";
import { runBackfillBusinessDatetimes } from "../src/scripts/backfill-business-datetimes";

describe("backfill-business-datetimes script", () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await DepositModel.deleteMany({});
    await WithdrawalModel.deleteMany({});
  });

  it("dry-run then apply then dry-run works and is idempotent", async () => {
    const actorId = new Types.ObjectId();
    const depositCreatedAt = new Date("2026-04-01T10:00:00.000Z");
    const withdrawalCreatedAt = new Date("2026-04-02T11:00:00.000Z");

    await DepositModel.create([
      {
        bankName: "Bank A",
        utr: "BF-UTR-001",
        amount: 100,
        status: "pending",
        createdBy: actorId,
        createdAt: depositCreatedAt,
      },
      {
        bankName: "Bank B",
        utr: "BF-UTR-002",
        amount: 150,
        status: "pending",
        createdBy: actorId,
        createdAt: new Date("2026-04-03T12:00:00.000Z"),
        entryAt: new Date("2026-04-03T12:30:00.000Z"),
      },
    ]);

    await WithdrawalModel.create([
      {
        playerName: "Player One",
        bankName: "Payout Bank",
        amount: 200,
        status: "requested",
        createdBy: actorId,
        createdAt: withdrawalCreatedAt,
      },
      {
        playerName: "Player Two",
        bankName: "Payout Bank",
        amount: 250,
        status: "requested",
        createdBy: actorId,
        createdAt: new Date("2026-04-04T13:00:00.000Z"),
        requestedAt: new Date("2026-04-04T13:30:00.000Z"),
      },
    ]);

    const dryRunBefore = await runBackfillBusinessDatetimes({ dryRun: true });
    expect(dryRunBefore.deposits.matched).toBe(1);
    expect(dryRunBefore.deposits.modified).toBe(0);
    expect(dryRunBefore.withdrawals.matched).toBe(1);
    expect(dryRunBefore.withdrawals.modified).toBe(0);

    const applied = await runBackfillBusinessDatetimes({ dryRun: false });
    expect(applied.deposits.matched).toBe(1);
    expect(applied.deposits.modified).toBe(1);
    expect(applied.withdrawals.matched).toBe(1);
    expect(applied.withdrawals.modified).toBe(1);

    const updatedDeposit = await DepositModel.findOne({ utr: "BF-UTR-001" }).lean();
    expect(updatedDeposit?.entryAt?.toISOString()).toBe(depositCreatedAt.toISOString());
    const preservedDeposit = await DepositModel.findOne({ utr: "BF-UTR-002" }).lean();
    expect(preservedDeposit?.entryAt?.toISOString()).toBe("2026-04-03T12:30:00.000Z");

    const updatedWithdrawal = await WithdrawalModel.findOne({ playerName: "Player One" }).lean();
    expect(updatedWithdrawal?.requestedAt?.toISOString()).toBe(withdrawalCreatedAt.toISOString());
    const preservedWithdrawal = await WithdrawalModel.findOne({ playerName: "Player Two" }).lean();
    expect(preservedWithdrawal?.requestedAt?.toISOString()).toBe("2026-04-04T13:30:00.000Z");

    const dryRunAfter = await runBackfillBusinessDatetimes({ dryRun: true });
    expect(dryRunAfter.deposits.matched).toBe(0);
    expect(dryRunAfter.withdrawals.matched).toBe(0);
  });
});
