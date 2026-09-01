import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { bootstrapData } from "../src/shared/db/bootstrap";
import { UserModel } from "../src/modules/users/user.model";
import { BankModel } from "../src/modules/bank/bank.model";
import { ExchangeModel } from "../src/modules/exchange/exchange.model";
import { PlayerModel } from "../src/modules/player/player.model";
import { PlatformSettingsModel, PLATFORM_SETTINGS_KEY } from "../src/modules/settings/settings.model";
import { ExchangeRateModel } from "../src/modules/masters/exchange-rate.model";
import {
  WITHDRAWAL_IMPORT_CSV_HEADER_LIST,
  applyWithdrawalImportRows,
  validateWithdrawalImportRows,
  type WithdrawalImportCommitRow,
} from "../src/modules/withdrawal/withdrawal-import.service";
import { WithdrawalModel } from "../src/modules/withdrawal/withdrawal.model";

const HEADER = WITHDRAWAL_IMPORT_CSV_HEADER_LIST.join(",");

function csvRow(values: string[]): string {
  return values.map((v) => (v.includes(",") ? `"${v}"` : v)).join(",");
}

async function ensurePlatformCurrency(actorId: string, currency: "INR" | "USD" = "INR") {
  await PlatformSettingsModel.findOneAndUpdate(
    { key: PLATFORM_SETTINGS_KEY },
    {
      $set: {
        platformCurrency: currency,
        currencyLockedAt: new Date(),
        currencyLockedBy: new mongoose.Types.ObjectId(actorId),
      },
    },
    { upsert: true },
  );
}

describe("withdrawal import FX", () => {
  let mongo: MongoMemoryServer;
  let actorId = "";
  let payoutBankId = "";
  let playerMongoId = "";

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await bootstrapData();

    const actor = await UserModel.findOne({ username: "superadmin" }).select("_id").lean();
    actorId = String(actor!._id);
    await ensurePlatformCurrency(actorId, "INR");

    const bank = await BankModel.create({
      holderName: "Import FX Payout Bank",
      bankName: "FX Bank",
      accountNumber: "888888888801",
      ifsc: "FXBK0000888",
      openingBalance: 100_000,
      currentBalance: 100_000,
      status: "active",
      createdBy: actorId,
    });
    payoutBankId = String(bank._id);

    const exchange = await ExchangeModel.create({
      name: "FX Exchange WDR",
      provider: "test",
      openingBalance: 0,
      currentBalance: 0,
      status: "active",
      createdBy: actorId,
      updatedBy: actorId,
    });
    const player = await PlayerModel.create({
      exchange: exchange._id,
      playerId: "WDR-PLAYER-001",
      phone: "9000000099",
      userType: "trader",
      createdBy: actorId,
      updatedBy: actorId,
    });
    playerMongoId = String(player._id);

    await ExchangeRateModel.create({
      fromCurrency: "USD",
      toCurrency: "INR",
      rate: 83,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  beforeEach(async () => {
    await WithdrawalModel.deleteMany({});
  });

  function commitRow(overrides: Partial<WithdrawalImportCommitRow> = {}): WithdrawalImportCommitRow {
    const amount = overrides.amount ?? 5000;
    const operatedAmount = overrides.operatedAmount ?? amount;
    return {
      playerMongoId,
      accountNumber: "123456789012",
      accountHolderName: "John Doe",
      bankName: "HDFC Bank",
      ifsc: "HDFC0001234",
      amount,
      operatedCurrency: "INR",
      operatedAmount,
      exchangeRate: 1,
      reverseBonus: 0,
      payoutUtr: `WDR-REF-${Math.random().toString(36).slice(2, 10)}`,
      payoutSettlementType: "bank",
      payoutBankId,
      ...overrides,
    };
  }

  it("imports platform currency rows with exchangeRate 1", async () => {
    const csv = [
      HEADER,
      csvRow([
        "",
        "WDR-PLAYER-001",
        "Bank",
        "888888888801",
        "",
        "WDR-REF-001",
        "123456789012",
        "John Doe",
        "HDFC Bank",
        "HDFC0001234",
        "",
        "5000",
      ]),
    ].join("\n");

    const result = await validateWithdrawalImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.operatedCurrency).toBe("INR");
    expect(result.validRows[0]?.exchangeRate).toBe(1);
    expect(result.validRows[0]?.amount).toBe(5000);
    expect(result.validRows[0]?.reverseBonus).toBe(0);
    expect(result.validRows[0]?.payableAmount).toBe(5000);

    const commit = await applyWithdrawalImportRows(
      [
        commitRow({
          payoutUtr: "WDR-REF-001",
          amount: 5000,
          operatedAmount: 5000,
          operatedCurrency: "INR",
          exchangeRate: 1,
          reverseBonus: 500,
        }),
      ],
      actorId,
    );
    expect(commit.created).toBe(1);

    const doc = await WithdrawalModel.findOne({ utr: "WDR-REF-001" }).lean();
    expect(doc?.operatedCurrency).toBe("INR");
    expect(doc?.exchangeRate).toBe(1);
    expect(doc?.operatedAmount).toBe(5000);
    expect(doc?.amount).toBe(5000);
    expect(doc?.reverseBonus).toBe(0);
    expect(doc?.payableAmount).toBe(5000);
  });

  it("ignores legacy Reverse Bonus column and stores reverseBonus as 0", async () => {
    const legacyHeader = `${HEADER},Reverse Bonus`;
    const csv = [
      legacyHeader,
      csvRow([
        "",
        "WDR-PLAYER-001",
        "Bank",
        "888888888801",
        "",
        "WDR-LEGACY-BONUS-001",
        "123456789012",
        "John Doe",
        "HDFC Bank",
        "HDFC0001234",
        "",
        "2500",
        "500",
      ]),
    ].join("\n");

    const result = await validateWithdrawalImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.reverseBonus).toBe(0);
    expect(result.validRows[0]?.payableAmount).toBe(2500);
  });

  it("converts foreign currency using master exchange rate", async () => {
    const csv = [
      HEADER,
      csvRow([
        "",
        "WDR-PLAYER-001",
        "Bank",
        "888888888801",
        "",
        "WDR-REF-USD-001",
        "123456789012",
        "John Doe",
        "HDFC Bank",
        "HDFC0001234",
        "USD",
        "100",
      ]),
    ].join("\n");

    const result = await validateWithdrawalImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.operatedCurrency).toBe("USD");
    expect(result.validRows[0]?.operatedAmount).toBe(100);
    expect(result.validRows[0]?.exchangeRate).toBe(83);
    expect(result.validRows[0]?.amount).toBe(8300);
  });

  it("accepts legacy Payout UTR header", async () => {
    const legacyHeader =
      "Date Time,Trader Wallet Id,Payout Settlement Type,Payout Bank,Payout Liable Person Name,Payout UTR,Account Number,Account Holder Name,Bank Name,IFSC,Amount";
    const csv = [
      legacyHeader,
      csvRow([
        "",
        "WDR-PLAYER-001",
        "Bank",
        "888888888801",
        "",
        "WDR-LEGACY-UTR-001",
        "123456789012",
        "John Doe",
        "HDFC Bank",
        "HDFC0001234",
        "3000",
      ]),
    ].join("\n");

    const result = await validateWithdrawalImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(1);
    expect(result.validRows[0]?.payoutUtr).toBe("WDR-LEGACY-UTR-001");
  });

  it("fails when master exchange rate is missing", async () => {
    const csv = [
      HEADER,
      csvRow([
        "",
        "WDR-PLAYER-001",
        "Bank",
        "888888888801",
        "",
        "WDR-REF-EUR-001",
        "123456789012",
        "John Doe",
        "HDFC Bank",
        "HDFC0001234",
        "EUR",
        "100",
      ]),
    ].join("\n");

    const result = await validateWithdrawalImportRows(Buffer.from(csv, "utf-8"), "import.csv");
    expect(result.summary.valid).toBe(0);
    expect(result.invalidRows[0]?.errors.join(" ")).toMatch(/No master exchange rate/i);
  });

  it("allows same payout reference when amount differs from existing withdrawal", async () => {
    const requestedAt = new Date("2024-03-10T10:00:00.000Z");
    await WithdrawalModel.create({
      player: new mongoose.Types.ObjectId(playerMongoId),
      playerName: "WDR-PLAYER-001",
      accountNumber: "123456789012",
      accountHolderName: "John Doe",
      bankName: "HDFC Bank",
      ifsc: "HDFC0001234",
      amount: 9000,
      operatedCurrency: "INR",
      operatedAmount: 9000,
      exchangeRate: 1,
      reverseBonus: 0,
      payableAmount: 9000,
      requestedAt,
      payoutSettlementType: "bank",
      payoutBankId: new mongoose.Types.ObjectId(payoutBankId),
      payoutBankName: "FX Bank",
      utr: "SHARED-REF-001",
      status: "requested",
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    const result = await applyWithdrawalImportRows(
      [
        commitRow({
          payoutUtr: "SHARED-REF-001",
          amount: 5000,
          operatedAmount: 5000,
          requestedAt: requestedAt.toISOString(),
        }),
      ],
      actorId,
    );

    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects import when all five composite fields match an existing withdrawal", async () => {
    const requestedAt = new Date("2024-04-15T12:00:00.000Z");
    await WithdrawalModel.create({
      player: new mongoose.Types.ObjectId(playerMongoId),
      playerName: "WDR-PLAYER-001",
      accountNumber: "123456789012",
      accountHolderName: "John Doe",
      bankName: "HDFC Bank",
      ifsc: "HDFC0001234",
      amount: 5000,
      operatedCurrency: "INR",
      operatedAmount: 5000,
      exchangeRate: 1,
      reverseBonus: 0,
      payableAmount: 5000,
      requestedAt,
      payoutSettlementType: "bank",
      payoutBankId: new mongoose.Types.ObjectId(payoutBankId),
      payoutBankName: "FX Bank",
      utr: "COMPOSITE-WDR-001",
      status: "requested",
      createdBy: new mongoose.Types.ObjectId(actorId),
    });

    const result = await applyWithdrawalImportRows(
      [
        commitRow({
          payoutUtr: "COMPOSITE-WDR-001",
          amount: 5000,
          operatedAmount: 5000,
          requestedAt: requestedAt.toISOString(),
        }),
        commitRow({
          payoutUtr: "COMPOSITE-WDR-OK",
          amount: 6000,
          operatedAmount: 6000,
        }),
      ],
      actorId,
    );

    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.utr).toBe("COMPOSITE-WDR-001");
    expect(result.errors[0]?.error).toMatch(/duplicate transaction already exists/i);
  });
});
